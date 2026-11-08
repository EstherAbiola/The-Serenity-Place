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
| `server/booking.js` | Availability, peak pricing, bed allocation, bookings, payments. |
| `server/paystack.js` | Paystack checkout, verification and webhook signatures. |
| `server/staff.js` | Front desk API: arrivals, bed board, walk-ins, check-in/out, team. |
| `server/db.js` | Database connection, setup and placeholder data. |
| `server/schema.sql` | Database tables. |

## How bookings work

- Each bed is booked night by night, and the database refuses any bed–night that is already taken, so double-booking can't happen.
- Beds marked `online = false` are the walk-in reserve: never sold on the website, only by staff.
- Dorms are single-sex. Guests choose a female or male dorm, and a group is kept in one room where possible.
- Peak-period prices apply automatically to nights that fall inside a peak period.
- Unpaid online bookings hold their beds for 30 minutes, then the beds are released.
- Payments go through Paystack once `PAYSTACK_SECRET_KEY` is set; until then the site runs in **preview mode** (no money taken).
- Every Paystack payment is checked server-side (amount and currency must match). Webhooks must carry a valid signature, and a payment reference is recorded only once.
- If money arrives after a hold expired, the booking gets beds again if any are free; otherwise it is flagged **needs attention** for staff to rehouse or refund.

## Front desk (`/staff`)

- **Today:** arrivals, departures, guests in house, free beds tonight (female/male, incl. walk-in reserve), what you collected today.
- **Upcoming:** arrivals for the next 7 days.
- **Beds:** every bed for the next 7 nights.
- **New booking:** walk-in or phone bookings, can use walk-in reserve beds; record cash, POS or transfer.
- **Find:** search by reference, name or phone.
- Actions: record payment, check in (ID type noted), check out, no-show, cancel (managers and owner only). Every action is logged with who did it.
- **Team** (owner only): add staff and managers, deactivate accounts.

Placeholder data (6 dorms, 40 beds, sample prices, one sample peak period) is created only in an empty database. It will be editable from the owner dashboard.

## Settings (secrets)

See `.env.example`. On GoDaddy, add them under **Settings → Secrets**. Never commit real values.

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon Postgres connection string. Without it, data is temporary and lost on restart. |
| `SESSION_SECRET` | Long random string that secures staff and owner logins. |
| `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_NAME` | First owner account, created on first start. |
| `PAYSTACK_SECRET_KEY` | Turns on Paystack. `sk_test_...` for testing, `sk_live_...` for real money. |
| `PUBLIC_URL` | Optional public address for the Paystack return link. |

## API (so far)

| Method | Path | Who |
| --- | --- | --- |
| GET | `/api/config` | Public: room types, prices, peak periods |
| GET | `/api/availability?checkin=&checkout=&gender=` | Public |
| POST | `/api/bookings` | Public: creates a booking and holds the beds |
| GET | `/api/bookings/:ref?email=` | Guest lookup |
| POST | `/api/bookings/:ref/pay` | Starts Paystack checkout |
| GET | `/pay/callback` | Guest returns from Paystack; payment verified |
| POST | `/api/paystack/webhook` | Paystack server notifications (signed) |
| POST | `/api/bookings/:ref/preview-pay` | Preview mode only |
| POST | `/api/auth/login`, `/api/auth/logout`, GET `/api/auth/me` | Staff and owner |
| GET/POST | `/api/staff/...` | Front desk: overview, upcoming, board, bookings, payments, check-in/out, no-show, cancel, team |

## Running locally

```
npm install
npm start            # http://localhost:3000
```

## Hosting on GoDaddy Node.js Hosting

Connect GitHub, pick this repository and the `main` branch, add the secrets above, then **Import & Deploy**.

In the Paystack dashboard (Settings → API Keys & Webhooks) set the **Webhook URL** to `https://YOUR-SITE/api/paystack/webhook`.
After later changes, use **Pull from GitHub**.
