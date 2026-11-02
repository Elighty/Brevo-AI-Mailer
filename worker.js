// Dispatch on Cloudflare Workers: you write the email, subscribers are de-duplicated (D1),
// and Brevo sends 300 a day until the whole list has it. Nobody is emailed twice.
const enc = new TextEncoder();
const isUrl = u => /^https?:\/\//i.test(u || '');
const dailyLimit = env => Number(env.DAILY_LIMIT) || 300;
const sql = (env, q, ...a) => env.DB.prepare(q).bind(...a);
const today = () => new Date().toISOString().slice(0, 10);
const FOOT = '<p style="font:12px Arial,sans-serif;color:#777;text-align:center"><a href="{{ unsubscribe }}" style="color:#777">Unsubscribe</a></p>';
// Brevo only sends marketing mail that has an unsubscribe link, so add one if the design has none.
const withUnsub = h => /\{\{\s*unsubscribe\s*\}\}/.test(h) ? h : /<\/body>/i.test(h) ? h.replace(/<\/body>/i, () => FOOT + '</body>') : h + FOOT;

let ready;
const init = env => ready ??= env.DB.batch([
  sql(env, `CREATE TABLE IF NOT EXISTS contacts (norm TEXT PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending')`),
  sql(env, `CREATE TABLE IF NOT EXISTS campaign (id INTEGER PRIMARY KEY, subject TEXT DEFAULT '', html TEXT DEFAULT '', active INTEGER DEFAULT 0, start_day TEXT DEFAULT '', send_hour INTEGER DEFAULT 8, day TEXT DEFAULT '', sent_today INTEGER DEFAULT 0, batch TEXT DEFAULT '', lock INTEGER DEFAULT 0, next_try INTEGER DEFAULT 0, last_error TEXT DEFAULT '')`),
  sql(env, `CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, sent INTEGER DEFAULT 0)`),
  sql(env, 'INSERT OR IGNORE INTO campaign (id, send_hour) VALUES (1, ?)', Number(env.SEND_HOUR_UTC ?? 8)),
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

// Email clients cannot play embeds, so a link becomes a clickable cover, a title and a button.
const OEMBED = [
  [/open\.spotify\.com/, 'https://open.spotify.com/oembed?url=', 'Listen on Spotify'],
  [/youtu\.?be/, 'https://www.youtube.com/oembed?format=json&url=', 'Watch on YouTube'],
  [/soundcloud\.com/, 'https://soundcloud.com/oembed?format=json&url=', 'Listen on SoundCloud'],
  [/vimeo\.com/, 'https://vimeo.com/api/oembed.json?url=', 'Watch on Vimeo'],
];

async function status(env) {
  const j = await sql(env, 'SELECT * FROM campaign WHERE id=1').first();
  const { results } = await sql(env, 'SELECT status, COUNT(*) AS n FROM contacts GROUP BY status').all();
  const days = (await sql(env, 'SELECT day, sent FROM days ORDER BY day DESC LIMIT 30').all()).results;
  const n = Object.fromEntries(results.map(r => [r.status, r.n]));
  return {
    pending: n.pending || 0, queued: n.queued || 0, sent: n.sent || 0, active: !!j.active, importing: !!j.batch,
    sentToday: j.day === today() ? j.sent_today : 0, limit: dailyLimit(env), sendHour: j.send_hour, startDay: j.start_day,
    error: j.last_error, today: today(), days,
    footer: `You are getting this because you subscribed to updates from ${env.SENDER_NAME || 'us'}.${env.MAIL_ADDRESS ? ' ' + env.MAIL_ADDRESS : ''}`,
  };
}

// One step of the sender. Runs every 5 minutes (cron) and when you press Start.
// Step 1 (at the chosen hour): take the next people in line, mark them 'queued', hand them to Brevo.
// Step 2 (once Brevo has them): send the campaign and mark them 'sent'. The daily limit makes it wait until tomorrow.
async function tick(env) {
  const now = Date.now();
  const got = await sql(env, 'UPDATE campaign SET lock=? WHERE id=1 AND lock<?', now + 120000, now).run();
  if (!got.meta.changes) return; // another run is already working
  let sending = false;
  try {
    const j = await sql(env, 'SELECT * FROM campaign WHERE id=1').first(), day = today();
    if (!j.active || !j.html || now < j.next_try) return;
    const sentToday = j.day === day ? j.sent_today : 0;

    if (j.batch) {
      const b = JSON.parse(j.batch);
      if ((await brevo(env, 'GET', `/processes/${b.processId}`)).status !== 'completed') return;
      const c = await brevo(env, 'POST', '/emailCampaigns', {
        name: `${j.subject} (${day})`, subject: j.subject, sender: { name: env.SENDER_NAME, email: env.SENDER_EMAIL },
        htmlContent: withUnsub(j.html), recipients: { listIds: [b.listId] },
      });
      sending = true;
      await brevo(env, 'POST', `/emailCampaigns/${c.id}/sendNow`);
      await env.DB.batch([
        sql(env, `UPDATE contacts SET status='sent' WHERE status='queued'`),
        sql(env, `UPDATE campaign SET batch='', day=?, sent_today=?, last_error='' WHERE id=1`, day, sentToday + b.n),
        sql(env, 'INSERT INTO days (day, sent) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET sent = sent + excluded.sent', day, b.n),
      ]);
      const left = await sql(env, `SELECT COUNT(*) AS n FROM contacts WHERE status='pending'`).first('n');
      if (!left) await sql(env, 'UPDATE campaign SET active=0 WHERE id=1').run(); // whole list done
      return;
    }

    const room = dailyLimit(env) - sentToday;
    if (room <= 0 || (j.start_day && day < j.start_day) || new Date().getUTCHours() < j.send_hour) return;
    const { results } = await sql(env,
      `UPDATE contacts SET status='queued' WHERE norm IN (SELECT norm FROM contacts WHERE status='pending' ORDER BY rowid LIMIT ?) RETURNING email`, room).all();
    if (!results.length) { await sql(env, 'UPDATE campaign SET active=0 WHERE id=1').run(); return; }
    try {
      const { folders } = await brevo(env, 'GET', '/contacts/folders?limit=1&offset=0');
      const list = await brevo(env, 'POST', '/contacts/lists', { name: `Batch ${new Date().toISOString().slice(0, 16)}`, folderId: folders[0].id });
      const imp = await brevo(env, 'POST', '/contacts/import', { jsonBody: results.map(r => ({ email: r.email })), listIds: [list.id], updateExistingContacts: true });
      await sql(env, `UPDATE campaign SET batch=?, day=?, sent_today=?, last_error='' WHERE id=1`,
        JSON.stringify({ listId: list.id, processId: imp.processId, n: results.length }), day, sentToday).run();
    } catch (e) { await sql(env, `UPDATE contacts SET status='pending' WHERE status='queued'`).run(); throw e; }
  } catch (e) {
    if (!sending || e.status) { // nothing went out: put people back in line and retry in an hour
      await env.DB.batch([
        sql(env, `UPDATE contacts SET status='pending' WHERE status='queued'`),
        sql(env, `UPDATE campaign SET batch='', last_error=?, next_try=? WHERE id=1`, e.message, now + 3600000),
      ]);
    } else { // unsure whether Brevo sent it: pause and keep these people marked so they are never emailed twice
      await sql(env, `UPDATE campaign SET batch='', active=0, last_error=? WHERE id=1`,
        `${e.message}. Check Brevo to see if the last campaign went out.`).run();
    }
  } finally { await sql(env, 'UPDATE campaign SET lock=0 WHERE id=1').run(); }
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

  'POST /api/embed': async (env, ctx, { url }) => {
    if (!isUrl(url)) throw new Error('That does not look like a web link');
    const p = OEMBED.find(([re]) => re.test(url));
    let title = '', image = '';
    if (p) try { const j = await (await fetch(p[1] + encodeURIComponent(url))).json(); title = j.title || ''; image = j.thumbnail_url || ''; } catch {}
    return { title, image, cta: p ? p[2] : 'Open the link' };
  },

  'POST /api/test': async (env, ctx, { subject, html, to }) => {
    if (!subject || !html || !to) throw new Error('Add a subject, some content and a test address');
    await brevo(env, 'POST', '/smtp/email', {
      sender: { name: env.SENDER_NAME, email: env.SENDER_EMAIL }, to: [{ email: to }],
      subject: `[Test] ${subject}`, htmlContent: withUnsub(html).replace(/\{\{\s*unsubscribe\s*\}\}/g, '#'),
    });
    return { ok: true };
  },

  'POST /api/start': async (env, ctx, { subject, html, startDay = '', sendHour }) => {
    const s = await status(env);
    if (s.importing) throw new Error('A batch is being prepared. Try again in a few minutes.');
    if (!s.pending && !s.queued && !s.sent) throw new Error('Add your subscribers first');
    const hour = Number.isInteger(sendHour) && sendHour >= 0 && sendHour <= 23 ? sendHour : s.sendHour;
    const dayOk = /^\d{4}-\d{2}-\d{2}$/.test(startDay) ? startDay : '';
    const fresh = !s.sent || !s.pending; // nothing sent yet, or the last round is complete
    if (fresh) {
      if (!subject || !html) throw new Error('Write the email first. It needs a subject and some content.');
      await env.DB.batch([
        sql(env, `UPDATE contacts SET status='pending'`),
        sql(env, `UPDATE campaign SET subject=?, html=?, active=1, start_day=?, send_hour=?, next_try=0, last_error='' WHERE id=1`, subject, html, dayOk, hour),
      ]);
    } else await sql(env, `UPDATE campaign SET active=1, start_day=?, send_hour=?, next_try=0, last_error='' WHERE id=1`, dayOk, hour).run();
    ctx.waitUntil(tick(env));
    return { ok: true, resumed: !fresh };
  },

  'POST /api/pause': async env => { await sql(env, 'UPDATE campaign SET active=0 WHERE id=1').run(); return { ok: true }; },

  'POST /api/reset': async (env, ctx, { clear }) => {
    if ((await status(env)).importing) throw new Error('A batch is being prepared. Try again in a few minutes.');
    await env.DB.batch([
      sql(env, clear ? 'DELETE FROM contacts' : `UPDATE contacts SET status='pending'`),
      sql(env, `UPDATE campaign SET active=0, subject='', html='', last_error='' WHERE id=1`),
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
