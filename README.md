# Brevo AI Mailer (Cloudflare)

Paste a music link, Claude writes the email, you upload your subscribers, and the app sends 300 a day through Brevo until everyone has it.

## How sending works

- **Duplicates:** when you upload, the app removes duplicates inside the file, rejects invalid addresses, and skips anyone already on your list. Gmail dots and `+tags` are treated as the same person.
- **300 a day:** every day at `SEND_HOUR_UTC` (default 08:00 UTC) the app takes the next 300 waiting people, sends them one Brevo campaign, then waits for the next day. Pressing **Start sending** sends the first batch immediately.
- **Nobody twice:** each person is marked `queued` before a batch leaves and `sent` after. Only `pending` people are ever picked. If something fails and the app cannot tell whether Brevo sent the campaign, it pauses and keeps those people marked so they are never emailed twice.
- **Finished:** when nobody is waiting, sending stops by itself and the page says "List complete".
- **Unsubscribes:** handled by Brevo. Anyone who unsubscribes is blocklisted in Brevo and skipped by future campaigns.

## Deploy: GitHub, then Cloudflare

1. **GitHub:** create a new private repository and upload everything in this folder, keeping `public/index.html` inside the `public` folder. Never upload a `.env` or `.dev.vars` file.
2. **Database:** in the Cloudflare dashboard open *Storage & databases > D1 > Create database*, name it `brevo-mailer`, and copy its Database ID. In GitHub, edit `wrangler.jsonc` and replace `PASTE-YOUR-D1-DATABASE-ID-HERE` with that ID. The tables are created automatically on first use.
3. **Deploy:** *Workers & Pages > Create > Import a repository*, pick your repo. Leave the build command empty and keep the deploy command as `npx wrangler deploy`. Every push to GitHub redeploys.
4. **Secrets:** open the new Worker, then *Settings > Variables and Secrets*, and add these as secrets:

| Name | Value |
| --- | --- |
| `APP_PASSWORD` | A long password. It protects your list, so do not skip it. |
| `BREVO_API_KEY` | Brevo > SMTP & API > API keys |
| `SENDER_EMAIL` | A verified sender in Brevo (domain with SPF and DKIM) |
| `SENDER_NAME` | Your artist or brand name |
| `MAIL_ADDRESS` | Postal address for the email footer |
| `ANTHROPIC_API_KEY` | console.anthropic.com > API keys |

5. Open your `*.workers.dev` address and enter the app password.

Optional settings live in `wrangler.jsonc`: `DAILY_LIMIT` (default 300), `SEND_HOUR_UTC` (default 8) and `CLAUDE_MODEL`.

## Good to know

- **Test emails count toward Brevo's daily total.** If you send tests, lower `DAILY_LIMIT` a little (for example 290) so a full batch is not rejected.
- Each daily batch appears in Brevo as a contact list named `Batch <date>` plus one campaign.
- If Brevo rejects a batch, the app puts those people back in line, shows the error on the page, and retries after an hour.
