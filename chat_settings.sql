create table if not exists public.chat_settings (
  chat_id text primary key,
  aggression integer not null default 60 check (aggression in (0, 30, 60, 100)),
  profanity boolean not null default true,
  stickers boolean not null default true
);

alter table public.messages
  add column if not exists telegram_message_id bigint;
