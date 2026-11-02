# Dispatch

Write your own email, pick a theme, upload your subscribers, and Dispatch sends it through Brevo 300 a day until the whole list has it.

## What it does

- **Write it yourself.** A visual editor with bold, italic, headings, lists, quotes, links, buttons, images and dividers. Your draft is saved in your browser as you type.
- **Themes.** Twelve ready-made themes (Newsletter, Letter, Plain, Midnight, Stage, Poster, Sage, Ocean, Berry, Sunset, Gold, Mono). Switch any time and your text restyles.
- **Paste from anywhere.** Copy from WordPress, Wix, Google Docs, Word or any website and paste into the editor. It keeps headings, bold, links, lists and images and drops the junk.
- **Import a whole design.** In the editor, press Import and paste the HTML (or choose an .html file) from WordPress, Wix, Mailchimp or similar. Use it as it is, or bring only the text into the editor. Unsubscribe and first-name tags from other platforms are converted for Brevo.
- **Embedded links.** Press Embed and paste a Spotify, YouTube, SoundCloud or Vimeo link. Email apps cannot play embeds, so it becomes a clickable cover, the title and a button, which is what gets clicks. Any other link becomes a button.
- **Schedule list.** Pick a start date and a daily send time. The Schedule tab lists every day with how many people get the email, what has been sent and when the last batch lands.
- **Duplicates.** Uploads are cleaned before saving: duplicates, invalid addresses and anyone already on the list are skipped. Gmail dots and `+tags` count as the same person.
- **Nobody twice.** Each person is marked before a batch leaves and only people still waiting are picked. If a send fails and it is unclear whether Brevo sent it, Dispatch pauses instead of risking a repeat.

## Deploy: GitHub, then Cloudflare

1. **GitHub:** create a private repository and upload everything in this folder, keeping `public/index.html` inside the `public` folder. Never upload `.env` or `.dev.vars`.
2. **Database:** Cloudflare dashboard > *Storage & databases > D1 > Create database*, name it `brevo-mailer`, copy the Database ID, and paste it into `wrangler.jsonc` in place of `PASTE-YOUR-D1-DATABASE-ID-HERE`. Tables are created automatically.
3. **Deploy:** *Workers & Pages > Create > Import a repository*. Leave the build command empty and keep the deploy command `npx wrangler deploy`. Every push to GitHub redeploys.
4. **Secrets:** Worker > *Settings > Variables and Secrets*:

| Name | Value |
| --- | --- |
| `APP_PASSWORD` | A long password. It protects your list. |
| `BREVO_API_KEY` | Brevo > SMTP & API > API keys |
| `SENDER_EMAIL` | A verified sender in Brevo (domain with SPF and DKIM) |
| `SENDER_NAME` | Your artist or brand name |
| `MAIL_ADDRESS` | Postal address for the email footer |

5. Open your `*.workers.dev` address and enter the password. `ANTHROPIC_API_KEY` is no longer needed.

`DAILY_LIMIT` (default 300) and the default send hour are in `wrangler.jsonc`. The send time you pick on the Schedule tab is what is used.

## Good to know

- **Images must be public web addresses.** Paste from WordPress or Wix keeps their image links. For your own pictures, upload them to any host and use Image in the toolbar.
- **Test emails count toward Brevo's daily total.** If you send tests, lower `DAILY_LIMIT` a little (for example 290).
- Each daily batch shows in Brevo as a contact list named `Batch <date>` plus one campaign.
- If Brevo rejects a batch, the people go back in line, the error shows at the top of the page, and Dispatch retries after an hour.
