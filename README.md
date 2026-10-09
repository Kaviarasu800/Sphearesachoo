# KAVI GROWTH — Full-stack Agency Website

A premium digital marketing agency website with a real lead-capture backend and admin dashboard.

## Stack
- Frontend: HTML, CSS, vanilla JavaScript
- Backend: dependency-free Node.js HTTP server
- Database: SQLite using Node's built-in `node:sqlite`

No `npm install` is required.

## Features
- Responsive agency landing page
- Service and pricing CTAs prefill the lead form
- Clickable case-study modal
- Real `POST /api/leads` lead capture
- Persistent SQLite database at `data/leads.db`
- Protected `/admin` dashboard
- Lead statuses: New, Contacted, Qualified, Won, Lost
- CSV export
- Form validation and basic per-IP rate limiting
- Security headers and request-size limiting
- `GET /api/health` health endpoint

## Run locally
1. Install Node.js 22.5 or newer.
2. Copy `.env.example` to `.env` and change `ADMIN_TOKEN`.
3. Open a terminal in this folder.
4. Run:

   node server.js

5. Website: `http://localhost:3000`
6. Admin: `http://localhost:3000/admin`

For a quick local test without `.env`, the development admin token is:

   dev-admin-token

Do not use that default token on a public deployment.

## API
### POST /api/leads
Public website lead endpoint. Required JSON fields: `name`, `business`, `email`, `service`, `budget`. Optional: `message`.

### GET /api/leads
Requires header: `x-admin-token: YOUR_ADMIN_TOKEN`.

### PATCH /api/leads/:id/status
Requires admin token. Body example:

    { "status": "Qualified" }

Allowed statuses: `New`, `Contacted`, `Qualified`, `Won`, `Lost`.

### GET /api/leads/export.csv
Requires admin token and returns a CSV download.

## Before deploying
- Set `NODE_ENV=production`.
- Set a long random `ADMIN_TOKEN`.
- Use HTTPS through your hosting provider/reverse proxy.
- Replace placeholder social links, sample results and testimonials.
- For larger production traffic, move the database to PostgreSQL/Supabase and add CAPTCHA plus email notifications.
