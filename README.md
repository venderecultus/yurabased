# Yura Telegram bot

## Run locally

1. Install Node.js 20+.
2. Create a Telegram bot with [@BotFather](https://t.me/BotFather) and copy its token.
3. Copy `.env.example` to `.env` and set `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`.
4. Run `npm install`, then `npm run dev`.

The 9Router-compatible base URL and model are configured in `src/index.ts`. The API key belongs in the environment only. Never commit `.env`.

## Conversation memory

Create a Supabase project, then run this SQL in its SQL Editor. If you already have the old `messages` table, run the migration immediately below first.

```sql
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  chat_id text not null,
  user_id text not null,
  author_name text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now(),
  summarized_at timestamptz
);

create index if not exists messages_pending_idx on public.messages (chat_id, id)
  where summarized_at is null;

create table if not exists public.chat_summaries (
  chat_id text primary key,
  summary text not null default '',
  recent_context text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.people (
  id bigint generated always as identity primary key,
  chat_id text not null,
  user_id text not null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (chat_id, user_id),
  unique (chat_id, id)
);

create table if not exists public.person_facts (
  id bigint generated always as identity primary key,
  chat_id text not null,
  person_id bigint not null,
  fact text not null,
  created_at timestamptz not null default now(),
  foreign key (chat_id, person_id) references public.people (chat_id, id) on delete cascade
);

create index if not exists person_facts_chat_id_idx on public.person_facts (chat_id, id desc);
```

Migration for an existing old `messages` table:

```sql
alter table public.messages add column if not exists user_id text not null default 'unknown';
alter table public.messages add column if not exists author_name text not null default 'unknown';
alter table public.messages add column if not exists summarized_at timestamptz;
create table if not exists public.chat_summaries (
  chat_id text primary key,
  summary text not null default '',
  recent_context text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.chat_summaries add column if not exists recent_context text not null default '';
```

Set `SUPABASE_URL` and the project's `SUPABASE_SERVICE_ROLE_KEY` in `.env`. The service-role key is secret and must never be exposed to users or committed. All incoming text and Yura's replies are stored with their authors. Every 20 unsummarized messages, Yura updates a long-term summary and extracts explicit facts into per-person records. A separate rolling context stores the last six chat messages and is refreshed on every message. Each reply receives that shared per-chat context, the long-term summary, up to 12 facts about the current speaker, the personality files (including `guardrails.md`), and the current message—not the raw full history. Send `юра лизав?` to clear the chat summary and rolling context; raw logs and people facts remain intact.

To send `здарова.)` to a chat after each bot startup, set `STARTUP_CHAT_ID` to that Telegram chat's ID. The bot must already have permission to send messages there. Leave it unset to disable the greeting.

## Run on Oracle Cloud VM

Install Node.js 20+ and Git on the VM, clone this project, then run:

```sh
npm ci
npm run build
```

Create `.env` on the VM with both tokens, then start with `npm start`. For automatic restarts after reboot/crash, run it under `systemd` or another process manager. Keep polling outbound-enabled in the VM firewall; no public webhook port is needed.

## Security

The API key pasted into chat should be revoked and replaced before deployment. Set the replacement directly in the VM's `.env`; do not send it in chat or add it to source control.
