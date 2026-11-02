// Brevo AI Mailer for Cloudflare Workers.
// AI-written emails, de-duplicated subscribers (D1), 300 emails/day through Brevo campaigns, nobody emailed twice.
const enc = new TextEncoder();
const isUrl = u => /^https?:\/\//i.test(u || '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dailyLimit = env => Number(env.DAILY_LIMIT) || 300;
const sendHour = env => Number(env.SEND_HOUR_UTC ?? 8);
const sql = (env, q, ...a) => env.DB.prepare(q).bind(...a);

let ready;
const init = env => ready ??= env.DB.batch([
  sql(env, `CREATE TABLE IF NOT EXISTS contacts (norm TEXT PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending')`),
  sql(env, `CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY, active INTEGER DEFAULT 0, copy TEXT DEFAULT '', day TEXT DEFAULT '', sent_today INTEGER DEFAULT 0, batch TEXT DEFAULT '', lock INTEGER DEFAULT 0, next_try INTEGER DEFAULT 0, last_error TEXT DEFAULT '')`),
  sql(env, 'INSERT OR IGNORE INTO job (id) VALUES (1)'),
]).catch(e => { ready = undefined; throw e; });

async function brevo(env, method, url, body) {
  const r = await fetch('https://api.brevo.com/v3' + url, {
    method, body: body && JSON.stringify(body),
    headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
  });
  const t = await r.text();
  let d = {}; try { d = JSON.parse(t); } catch {}
  if (!r.ok) throw Object.assign(new Error(`Brevo: ${d.message || r.status}`), { status: r.status });
  return d;
}

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

// The AI writes the words; this fixed email-safe layout does the HTML. Brevo fills in the unsubscribe link.
function render({ subject, preheader, headline, paragraphs = [], cta, link, cover }, env, unsub = '{{ unsubscribe }}') {
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
<p style="max-width:520px;margin:20px 0 0;font:12px/1.5 Arial,sans-serif;color:#625f80">You are getting this because you subscribed to updates from ${esc(env.SENDER_NAME)}.${env.MAIL_ADDRESS ? ' ' + esc(env.MAIL_ADDRESS) : ''}<br><a href="${unsub}" style="color:#625f80">Unsubscribe</a></p>
</td></tr></table></body></html>`;
}

async function status(env) {
  const today = new Date().toISOString().slice(0, 10);
  const j = await sql(env, 'SELECT * FROM job WHERE id=1').first();
  const { results } = await sql(env, 'SELECT status, COUNT(*) AS n FROM contacts GROUP BY status').all();
  const n = Object.fromEntries(results.map(r => [r.status, r.n]));
  return {
    pending: n.pending || 0, queued: n.queued || 0, sent: n.sent || 0, active: !!j.active, importing: !!j.batch,
    subject: j.copy ? JSON.parse(j.copy).subject : '', sentToday: j.day === today ? j.sent_today : 0,
    limit: dailyLimit(env), sendHour: sendHour(env), error: j.last_error,
  };
}

// One step of the sender. Runs every 5 minutes (cron) and when you press Start.
// Step 1: pick today's contacts, mark them 'queued', hand them to Brevo. Step 2: once Brevo has them, send the campaign.
async function tick(env, force = false) {
  const now = Date.now();
  const got = await sql(env, 'UPDATE job SET lock=? WHERE id=1 AND lock<?', now + 120000, now).run();
  if (!got.meta.changes) return; // another run is already working
  let sending = false;
  try {
    const j = await sql(env, 'SELECT * FROM job WHERE id=1').first();
    if (!j.active || !j.copy || (now < j.next_try && !force)) return;
    const copy = JSON.parse(j.copy), today = new Date().toISOString().slice(0, 10);
    const sentToday = j.day === today ? j.sent_today : 0;

    if (j.batch) {
      const b = JSON.parse(j.batch);
      if ((await brevo(env, 'GET', `/processes/${b.processId}`)).status !== 'completed') return;
      const c = await brevo(env, 'POST', '/emailCampaigns', {
        name: `${copy.subject} (${today})`, subject: copy.subject,
        sender: { name: env.SENDER_NAME, email: env.SENDER_EMAIL },
        htmlContent: render(copy, env), recipients: { listIds: [b.listId] },
      });
      sending = true;
      await brevo(env, 'POST', `/emailCampaigns/${c.id}/sendNow`);
      await env.DB.batch([
        sql(env, `UPDATE contacts SET status='sent' WHERE status='queued'`),
        sql(env, `UPDATE job SET batch='', day=?, sent_today=?, last_error='' WHERE id=1`, today, sentToday + b.n),
      ]);
      const left = await sql(env, `SELECT COUNT(*) AS n FROM contacts WHERE status='pending'`).first('n');
      if (!left) await sql(env, 'UPDATE job SET active=0 WHERE id=1').run(); // whole list done
      return;
    }

    const room = dailyLimit(env) - sentToday;
    if (room <= 0 || (!force && new Date().getUTCHours() < sendHour(env))) return; // today's quota used, or too early
    const { results } = await sql(env,
      `UPDATE contacts SET status='queued' WHERE norm IN (SELECT norm FROM contacts WHERE status='pending' ORDER BY rowid LIMIT ?) RETURNING email`, room).all();
    if (!results.length) { await sql(env, 'UPDATE job SET active=0 WHERE id=1').run(); return; }
    try {
      const { folders } = await brevo(env, 'GET', '/contacts/folders?limit=1&offset=0');
      const list = await brevo(env, 'POST', '/contacts/lists', { name: `Batch ${new Date().toISOString().slice(0, 16)}`, folderId: folders[0].id });
      const imp = await brevo(env, 'POST', '/contacts/import', { jsonBody: results.map(r => ({ email: r.email })), listIds: [list.id], updateExistingContacts: true });
      await sql(env, `UPDATE job SET batch=?, day=?, sent_today=?, last_error='' WHERE id=1`,
        JSON.stringify({ listId: list.id, processId: imp.processId, n: results.length }), today, sentToday).run();
    } catch (e) { await sql(env, `UPDATE contacts SET status='pending' WHERE status='queued'`).run(); throw e; }
  } catch (e) {
    if (!sending || e.status) { // nothing went out: put people back in line and retry in an hour
      await env.DB.batch([
        sql(env, `UPDATE contacts SET status='pending' WHERE status='queued'`),
        sql(env, `UPDATE job SET batch='', last_error=?, next_try=? WHERE id=1`, e.message, now + 3600000),
      ]);
    } else { // unsure whether Brevo sent it: pause and keep these people marked so they are never emailed twice
      await sql(env, `UPDATE job SET batch='', active=0, last_error=? WHERE id=1`,
        `${e.message}. Check Brevo to see if the last campaign went out.`).run();
    }
  } finally { await sql(env, 'UPDATE job SET lock=0 WHERE id=1').run(); }
}

const routes = {
  'GET /api/status': env => status(env),

  // The browser cleans and de-duplicates the file first; the primary key then rejects anyone already on the list.
  'POST /api/contacts': async (env, ctx, { rows = [] }) => {
    const ok = rows.slice(0, 5000).filter(r => Array.isArray(r) && /^[^\s@]+@[^\s@]+$/.test(r[1]));
    if (!ok.length) return { added: 0 };
    const r = await sql(env, `INSERT OR IGNORE INTO contacts (norm, email) SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(?)`, JSON.stringify(ok)).run();
    return { added: r.meta.changes };
  },

  'POST /api/generate': async (env, ctx, { prompt = '', link = '', tone = 'warm and personal' }) => {
    if (!isUrl(link)) throw new Error('Add a link that starts with https://');
    const sp = await spotifyInfo(link);
    const brief = `Artist: ${env.SENDER_NAME}\nLink: ${link}\n${sp.title ? `Spotify title: ${sp.title}\n` : ''}Tone: ${tone}\nNotes from the artist: ${prompt || '(none)'}`;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: 1000, system: SYSTEM, messages: [{ role: 'user', content: brief }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Claude: ${j.error?.message || r.status}`);
    const txt = j.content.map(c => c.text || '').join('');
    let copy;
    try { copy = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); }
    catch { throw new Error('The AI reply was malformed. Click the button again.'); }
    copy.paragraphs = [].concat(copy.paragraphs || []);
    copy.link = link; copy.cover = sp.cover || '';
    return { copy, html: render(copy, env) };
  },

  'POST /api/render': (env, ctx, { copy = {} }) => ({ html: render(copy, env) }),

  'POST /api/test': async (env, ctx, { copy, to }) => {
    if (!copy?.subject || !to) throw new Error('Add a subject line and a test address');
    await brevo(env, 'POST', '/smtp/email', {
      sender: { name: env.SENDER_NAME, email: env.SENDER_EMAIL }, to: [{ email: to }],
      subject: `[Test] ${copy.subject}`, htmlContent: render(copy, env, '#'),
    });
    return { ok: true };
  },

  'POST /api/start': async (env, ctx, { copy }) => {
    const s = await status(env);
    if (s.importing) throw new Error('A batch is being prepared. Try again in a few minutes.');
    if (!s.pending && !s.queued && !s.sent) throw new Error('Add your subscribers first');
    const fresh = !s.sent || !s.pending; // nothing sent yet, or the last round is complete
    if (fresh) {
      if (!copy?.subject) throw new Error('Write the email first');
      await env.DB.batch([
        sql(env, `UPDATE contacts SET status='pending'`),
        sql(env, `UPDATE job SET copy=?, active=1, next_try=0, last_error='' WHERE id=1`, JSON.stringify(copy)),
      ]);
    } else await sql(env, `UPDATE job SET active=1, next_try=0, last_error='' WHERE id=1`).run();
    ctx.waitUntil(tick(env, true));
    return { ok: true, resumed: !fresh };
  },

  'POST /api/pause': async env => { await sql(env, 'UPDATE job SET active=0 WHERE id=1').run(); return { ok: true }; },

  'POST /api/reset': async (env, ctx, { clear }) => {
    if ((await status(env)).importing) throw new Error('A batch is being prepared. Try again in a few minutes.');
    await env.DB.batch([
      sql(env, clear ? 'DELETE FROM contacts' : `UPDATE contacts SET status='pending'`),
      sql(env, `UPDATE job SET active=0, copy='', last_error='' WHERE id=1`),
    ]);
    return { ok: true };
  },
};

export default {
  async fetch(req, env, ctx) {
    const route = routes[`${req.method} ${new URL(req.url).pathname}`];
    if (!route) return env.ASSETS.fetch(req);
    const a = enc.encode(req.headers.get('x-app-password') || ''), b = enc.encode(env.APP_PASSWORD || '');
    if (!b.length || a.length !== b.length || !crypto.subtle.timingSafeEqual(a, b))
      return Response.json({ error: 'Wrong app password' }, { status: 401 });
    try {
      await init(env);
      return Response.json(await route(env, ctx, req.method === 'POST' ? await req.json().catch(() => ({})) : {}));
    } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
  },
  async scheduled(_, env, ctx) { ctx.waitUntil(init(env).then(() => tick(env))); },
};
