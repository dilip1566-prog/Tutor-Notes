-- Study Notebook: tables in the Neon (PostgreSQL) database.
-- One notepad per tutor; each note has text, links and files.

create table if not exists tutors (
  id          text primary key,              -- t1, t2, t3, or t<timestamp> for tutors added later
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists students (
  id    text primary key,
  name  text not null
);

-- Note numbers start at 5001 and are never reused. The database hands them out,
-- so two people creating notes at the same moment can't get the same number.
create sequence if not exists note_num_seq start 5001;

create table if not exists notes (
  id          text primary key,
  num         integer not null unique default nextval('note_num_seq'),
  tutor_id    text not null references tutors(id),
  title       text not null default '',
  body        text not null default '',
  sort_key    bigint not null,               -- list order: highest first (Move to top / up / down change this)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists notes_tutor_order on notes (tutor_id, sort_key desc);

create table if not exists note_links (
  id        bigint generated always as identity primary key,
  note_id   text not null references notes(id) on delete cascade,
  position  integer not null default 0,
  url       text not null,
  label     text not null default ''
);

create table if not exists note_files (
  id          text primary key,
  note_id     text not null references notes(id) on delete cascade,
  name        text not null,
  mime_type   text not null default '',
  size_bytes  integer not null,
  data        bytea not null,                -- the file itself
  created_at  timestamptz not null default now()
);
create index if not exists note_files_note on note_files (note_id);
