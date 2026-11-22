# Security notes for a public repository

- **No secrets belong here.** Passwords, API keys, session secrets and reviewer contact details are entered in the
  hosting provider's settings (or a local `.env`, which is git-ignored). `deploy/env.example` holds blanks only.
- **The password `Pilot-Demo-2026!` in the code is a development convenience** for fictional local accounts. The
  seed scripts refuse to run with it when `NODE_ENV=production`. Hosted review mode gives every built-in persona a
  random password and takes the reviewer's and owner's passwords from the host's settings.
- One-click demo sign-in is disabled in production.
- To report a problem, contact the repository owner privately rather than opening a public issue.
