-- ZiFii OS access module: who may connect, how fast and until when.
-- Country is a setting from the start so a second market does not need a copy of the system.

create table countries (
  code char(2) primary key,
  name text not null,
  currency char(3) not null,
  timezone text not null
);

insert into countries (code, name, currency, timezone)
values ('ZM', 'Zambia', 'ZMW', 'Africa/Lusaka');

create table sites (
  id uuid primary key default gen_random_uuid(),
  country_code char(2) not null references countries (code),
  name text not null,
  -- NAS-Identifier the site's router sends with every RADIUS request.
  nas_identifier text not null unique,
  created_at timestamptz not null default now()
);

create table plans (
  id uuid primary key default gen_random_uuid(),
  country_code char(2) not null references countries (code),
  code text not null,
  name text not null,
  duration_seconds integer not null check (duration_seconds > 0),
  download_kbps integer not null check (download_kbps > 0),
  upload_kbps integer not null check (upload_kbps > 0),
  max_devices integer not null default 1 check (max_devices > 0),
  -- Left empty until pilot figures set prices. Minor units of the country's currency.
  price_minor bigint check (price_minor >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (country_code, code)
);

create table subscribers (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites (id),
  kind text not null check (kind in ('resident', 'guest')),
  username text not null unique,
  password_hash text not null,
  display_name text,
  phone text,
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table entitlements (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references subscribers (id) on delete cascade,
  plan_id uuid not null references plans (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  source text not null check (source in ('admin', 'voucher', 'payment')),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index entitlements_subscriber_ends on entitlements (subscriber_id, ends_at);

create table vouchers (
  code text primary key,
  site_id uuid not null references sites (id),
  plan_id uuid not null references plans (id),
  batch text not null,
  -- Last moment the voucher can be redeemed; the plan's clock starts at redemption.
  expires_at timestamptz,
  redeemed_at timestamptz,
  subscriber_id uuid references subscribers (id),
  created_at timestamptz not null default now()
);

create index vouchers_site_batch on vouchers (site_id, batch);

-- RADIUS accounting. These are the session records ZICTA rules expect to be kept centrally.
create table radius_sessions (
  id bigserial primary key,
  nas_identifier text not null,
  acct_session_id text not null,
  site_id uuid references sites (id),
  subscriber_id uuid references subscribers (id) on delete set null,
  username text not null,
  calling_station_id text,
  framed_ip inet,
  nas_ip inet,
  started_at timestamptz not null,
  updated_at timestamptz not null,
  stopped_at timestamptz,
  input_octets bigint not null default 0,
  output_octets bigint not null default 0,
  terminate_cause text,
  unique (nas_identifier, acct_session_id)
);

create index radius_sessions_open_by_subscriber on radius_sessions (subscriber_id)
  where stopped_at is null;
create index radius_sessions_site_started on radius_sessions (site_id, started_at);
