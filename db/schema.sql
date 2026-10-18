-- Run once in the Neon SQL editor.
create table sessions (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'awaiting_input' check (status in
    ('awaiting_input','organizing','interviewing','paused','drafting','reviewing','approved','shared','cancelled')),
  input_url text,
  input_line text,
  website_text text,
  cursor_field text,
  revision int not null default 1,
  approved_revision int,
  time_budget_min int,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table fields (
  session_id uuid references sessions(id) on delete cascade,
  field_id text not null,
  label text not null,
  status text not null default 'gap' check (status in ('gap','vague','known','unknown','declined')),
  value text,
  kind text check (kind in ('observation','claim','assumption')),
  source text check (source in ('user','website')),
  evidence_quote text,
  confidence real,
  sensitive boolean default false,
  redaction text,
  redaction_accepted boolean,
  asked_count int default 0,
  updated_revision int default 1,
  primary key (session_id, field_id)
);

create table field_history (
  id bigint generated always as identity primary key,
  session_id uuid references sessions(id) on delete cascade,
  field_id text, revision int, old_value text, new_value text, reason text,
  created_at timestamptz default now()
);

create table messages (
  id bigint generated always as identity primary key,
  session_id uuid references sessions(id) on delete cascade,
  role text check (role in ('user','agent','system')),
  channel text check (channel in ('text','voice')),
  content text,
  created_at timestamptz default now()
);

create table decisions (
  decision_id text primary key,
  session_id uuid references sessions(id) on delete cascade,
  type text, payload jsonb, result jsonb,
  created_at timestamptz default now()
);

create table briefs (
  id bigint generated always as identity primary key,
  session_id uuid references sessions(id) on delete cascade,
  revision int not null,
  audience text check (audience in ('snapshot','builder','public','exec')),
  content text,
  created_at timestamptz default now(),
  unique (session_id, revision, audience)
);
