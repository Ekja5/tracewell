# Hosting Tracewell for an outside reviewer

This runs one synthetic demo account ("Northline Orthopedic Supply") on a server you control, with HTTPS,
a sign-in for the reviewer and one for you. No real data. The assistant runs in demo mode.

## What you need

- A small Linux server with Docker (2 GB RAM is enough) and ports 80 and 443 open.
- A domain or subdomain whose DNS A record points at that server, for example `review.yourcompany.com`.

## Steps

1. Copy this repository to the server.
2. `cd deploy && cp env.example .env` and fill in every value:
   - `SITE_DOMAIN`: the subdomain above.
   - Three random secrets: `POSTGRES_ADMIN_PASSWORD`, `APP_DB_PASSWORD`, `SESSION_SECRET` (`openssl rand -base64 36`).
   - `REVIEWER_EMAIL`, `REVIEWER_NAME`, `REVIEWER_PASSWORD` (12+ characters).
   - `OWNER_EMAIL`, `OWNER_NAME`, `OWNER_PASSWORD` for yourself.
3. `docker compose up -d --build`. The first start builds the demo account (about 20 seconds).
4. Open `https://<SITE_DOMAIN>`, sign in as the owner, and walk the Reviewer guide once yourself.
5. Only then send the reviewer the link, and send the password by a different channel (text or phone).

## Operating it

| Task | How |
|---|---|
| Read feedback | Sign in as the owner → **Feedback received**. Raw file: `docker compose exec app cat /data/feedback.jsonl` |
| Reset the demo to 9:00 AM | **Reviewer guide → Restart the demo** (either sign-in). Feedback is kept |
| Change a password | Edit `.env`, `docker compose up -d`, then restart the demo once |
| Turn it off | `docker compose down` (add `-v` to delete data and feedback) |

## What review mode does

- One-click demo sign-ins are off; every built-in persona gets a random password, so only the reviewer and owner can sign in.
- Five wrong passwords lock that sign-in for five minutes.
- Pages are served with `noindex` so search engines do not list the site.
- The demo clock starts at 9:00 AM Central on the next Monday to Thursday and then runs in real time.

## Not verified

The Docker image and compose file were written but not built here (no Docker daemon in the build environment).
The same server code was run in production mode with these settings and the reviewer's path was tested in a browser.
Expect to fix small things on the first `docker compose up`.
