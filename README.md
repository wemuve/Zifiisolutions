# ZiFii OS

The software that runs ZiFii's managed Wi-Fi service. This first module decides who may
connect at a ZiFii site, how fast and until when, and keeps the session records the law
expects. It follows the build order in the ZiFii Network Architecture (v1, section 6):
plans and entitlements first, driving the RADIUS login system.

## What it does

- **Sites** are registered by the `NAS-Identifier` their router sends.
- **Plans** set duration, download and upload speed, and how many devices may be online at
  once. Prices stay empty until the pilot figures set them.
- **Residents** get a username and password at their site. Staff issue them a plan, which
  becomes an **entitlement** with a start and end time, and can revoke it or disable the account.
- **Guest vouchers** are printed in batches. A guest types the code on the login page; the first
  login creates the guest account and starts the plan's clock.
- **Logins** from FreeRADIUS are accepted only with the right password, an active plan at the
  right site and a free device slot. The reply carries `Session-Timeout` (until the plan ends) and
  speed limits as both WISPr and `Mikrotik-Rate-Limit` attributes.
- **Accounting** records every session (user, device MAC, private IP, start, stop, bytes). Router
  restarts close that router's open sessions, and a session with no update for
  `STALE_SESSION_MINUTES` stops counting towards the device limit.
- **Countries** are a setting from the start. Zambia (ZMW, Africa/Lusaka) is seeded.

Not in this module yet: paid plans through Airtel Money, the captive portal page itself, the
site status view and the property-owner portal.

## Running it

Needs Node 22 and PostgreSQL 16.

```sh
cp .env.example .env          # then set real tokens and the database URL
npm install
npm run migrate               # or: node dist/src/migrate.js after a build
npm run dev                   # or: npm run build && npm start
```

Tests use a real database, which they wipe:

```sh
createdb zifii_test
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/zifii_test npm test
```

## FreeRADIUS

`deploy/freeradius` holds an `rlm_rest` module and a virtual server that relay every login
and accounting record to this service. Tested with FreeRADIUS 3.2.5 (`freeradius-rest`).
Set `ZIFII_OS_URL` and `ZIFII_RADIUS_API_TOKEN` in FreeRADIUS's environment, and add each
site router to `clients.conf` with its own secret, reached over the site's tunnel.

## API

All `/admin` calls need `Authorization: Bearer $ADMIN_API_TOKEN`; all `/radius` calls need
`Authorization: Bearer $RADIUS_API_TOKEN`.

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Liveness and database check |
| `GET, POST /admin/sites` | List or register sites |
| `GET, POST /admin/plans` | List or create plans |
| `POST /admin/subscribers` | Register a resident |
| `GET, PATCH /admin/subscribers/:id` | View a subscriber and their plans; disable or re-enable |
| `POST /admin/subscribers/:id/entitlements` | Issue a plan |
| `POST /admin/entitlements/:id/revoke` | Revoke a plan |
| `POST /admin/vouchers` | Print a batch of guest voucher codes |
| `GET /admin/sites/:id/sessions` | Who is online at a site now |
| `POST /radius/authorize` | Called by FreeRADIUS for each login |
| `POST /radius/accounting` | Called by FreeRADIUS for each accounting record |

Example: a resident plan and a batch of day passes.

```sh
curl -X POST localhost:8080/admin/plans -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"code":"resident-standard","name":"Resident Standard","durationSeconds":2592000,
       "downloadKbps":10000,"uploadKbps":3000,"maxDevices":3}'

curl -X POST localhost:8080/admin/vouchers -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"siteId":"<site id>","planId":"<day pass plan id>","count":50}'
```

## Known limits

- Staff sign in with one shared admin token. Company sign-in with two-factor login, as the
  architecture requires, should replace it before more than one person uses the API.
- Session records hold the private IP. Mapping it to the public address and port needs the
  router's NAT logs in central syslog.
- How long session records must be kept, and whether residents' data may be stored outside
  Zambia, are still marked "to confirm" in the architecture.
