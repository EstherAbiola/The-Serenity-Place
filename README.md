# Serenity Place Residences

*Pristine Living. Peaceful Stays. · Ìtura àti Àlàáfíà.*

Website and booking system for Serenity Place Residences.

## Structure

| Path | What it is |
| --- | --- |
| `public/index.html` | The website. Text, photos and contact details live in its `CONFIG` block. |
| `public/staff.html` | Front desk screen at `/staff` (login required). |
| `public/assets/` | Logo, and `photos/` for real room photos. |
| `server.js` | Entry point (`npm start`). |
| `server/app.js` | Routes: website, booking API, staff/owner login. |
| `server/booking.js` | Availability, peak pricing, bed allocation, bookings, front-desk payments. |
| `server/staff.js` | Front desk API: arrivals, bed board, walk-ins, check-in/out, team. |
| `server/owner.js` | Owner dashboard, CSV exports, and settings (prices, peak periods, rooms, beds). |
| `server/expenses.js` | Expense log with receipts and owner approval. |
| `server/util.js` | Shared helpers (date ranges, CSV, settings). |
| `server/team.js` | Rota, clock-in/out, attendance, targets, salaries and payroll. |
| `server/careers.js` | Careers page API and the applications inbox. |
| `server/email.js` | Emails through GoDaddy's built-in email gateway. |
| `public/careers.html` | Public careers page at `/careers`. |
| `server/db.js` | Database connection, setup and placeholder data. |
| `server/schema.sql` | Database tables. |

## How bookings work

- Each bed is booked night by night, and the database refuses any bed–night that is already taken, so double-booking can't happen.
- Beds marked `online = false` are the walk-in reserve: never sold on the website, only by staff.
- Dorms are single-sex. Guests choose a female or male dorm, and a group is kept in one room where possible.
- Peak-period prices apply automatically to nights that fall inside a peak period.
- Online bookings are **reservations paid on arrival** (cash, POS or transfer at the front desk). Staff record the payment, or mark a no-show to release the beds.

Placeholder data (6 dorms, 40 beds, sample prices, one sample peak period) is created only in an empty database. It will be editable from the owner dashboard.

## Emails

Sent through GoDaddy Node.js Hosting's built-in gateway (`http://127.0.0.1:2525`), so no email account or keys are needed: reservation confirmations, payment receipts, application acknowledgements and payslips. Every attempt is recorded in the `email_log` table; outside GoDaddy they are logged as "skipped". To use **Resend** instead, add `RESEND_API_KEY` (and, once a domain is verified in Resend, `EMAIL_FROM` such as `Serenity Place <bookings@yourdomain.com>`). Until a domain is verified, Resend only delivers to the Resend account's own email address. Optional `NOTIFY_EMAIL` also sends the team an alert for new reservations and job applications.

## Settings

**No secrets are required.** The app runs as soon as it is deployed.

- **Owner login:** on first start the app prints a one-time setup code in the server logs (GoDaddy → Runtime Logs, line starting `[setup]`). Open `/staff`, enter the code and create the owner account. The owner then adds staff under **Team**.
- **Data:** without `DATABASE_URL` the app uses a temporary in-memory database, so bookings are lost whenever the app restarts. Fine for a preview; add a database before taking real bookings.

Optional settings (`.env.example`):

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon Postgres connection string, to keep data permanently. |
| `SESSION_SECRET` | Keeps staff logged in across restarts. |
| `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_NAME` | Alternative to the setup code: creates the owner account on start. |
| `NOTIFY_EMAIL` | Team inbox for new-reservation and new-application alerts. |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | Send email through Resend instead of GoDaddy's gateway. |
| `CONTACT_PHONE`, `CONTACT_ADDRESS` | Shown at the bottom of emails. |

## API (so far)

| Method | Path | Who |
| --- | --- | --- |
| GET | `/api/config` | Public: room types, prices, peak periods |
| GET | `/api/availability?checkin=&checkout=&gender=` | Public |
| POST | `/api/bookings` | Public: reserves beds (paid on arrival) |
| GET | `/api/bookings/:ref?email=` | Guest lookup |
| POST | `/api/auth/login`, `/api/auth/logout`, GET `/api/auth/me` | Staff and owner |
| GET/POST | `/api/auth/setup` | One-time owner setup with the code from the logs |
| GET/POST | `/api/staff/...` | Front desk: overview, upcoming, board, bookings, payments, check-in/out, no-show, cancel, team |

## Running locally

```
npm install
npm start            # http://localhost:3000
```

## Hosting on GoDaddy Node.js Hosting

Connect GitHub, pick this repository and the `main` branch, then **Import & Deploy**. No secrets are needed.

GoDaddy only allows outbound connections on ports 80/443, so if `DATABASE_URL` points at Neon (`*.neon.tech`) the app uses Neon's serverless driver over port 443. `.npmrc` pins the public npm registry, as GoDaddy requires.
After later changes, use **Pull from GitHub**.
