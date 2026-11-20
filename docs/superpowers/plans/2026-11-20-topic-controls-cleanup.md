# Topic Controls and Cleanup Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow the admin to block every Yura message in selected Telegram forum topics and let any group member trigger deletion of Yura's five latest messages with a five-minute cooldown.

**Architecture:** Persist topic allow/deny state alongside chat settings, identify a topic by `(chat_id, message_thread_id)`, and guard every outbound Yura response path. Handle the cleanup phrase before normal message processing, using stored Telegram message IDs and a per-chat cooldown.

**Tech Stack:** TypeScript, grammY, Supabase/Postgres.

**Spec:** User request in the active conversation.

## Global Constraints

- Keep existing chats and settings working by default.
- Only block Yura's outbound messages for configured topics; do not block user message storage or bot administrative controls.
- Cleanup applies to up to the latest five stored assistant messages in the current chat, and has a five-minute per-chat cooldown.
- The cleanup phrase is available to all participants.

## Review Focus

- Unseen topics — settings can only enumerate topics the bot has observed, since Telegram does not offer a list-topics API.
- Bot permissions / messages older than Telegram's deletion limits — deletion failure must not crash the handler; report partial completion.
- Cooldown restart behavior — in-memory cooldown resets on process restart; use durable storage if strict persistence is required.
- Group reply and unsolicited paths — both must respect blocked-topic state.
- Topic-less messages — preserve existing chat-wide behavior.

---

### Task 1: Topic-aware chat settings

**Files:**
- Modify: `src/index.ts` settings load/display/callback and message handler.
- Modify: `chat_settings.sql` schema.

**Interfaces:**
- Store observed topic identifiers and enabled/blocked state per chat in a durable table keyed by chat and thread ID.
- Topic settings default to allowed; settings UI shows observed topics with a toggle.

- [ ] Add the SQL table/migration for observed topics and blocked state.
- [ ] Add settings listing/toggle and record forum topics when messages arrive.
- [ ] Guard every Yura output path, including generated replies, unsolicited messages, and stickers, with topic state.
- [ ] Run `rtk npm test` and verify the TypeScript build passes.

### Task 2: “Юра подчищай” command

**Files:**
- Modify: `src/index.ts` incoming message handling.
- Modify: `chat_settings.sql` only if durable cooldown storage is chosen.

**Interfaces:**
- Exact phrase match is case-insensitive and whitespace-tolerant.
- Select up to five latest assistant messages for the current chat; delete each Telegram message and corresponding history row.
- Enforce a five-minute per-chat cooldown and give useful success/partial/failure feedback.

- [ ] Add cooldown and deletion behavior before standard AI handling.
- [ ] Ensure deletion failures are isolated per message and do not delete unrelated user messages.
- [ ] Run `rtk npm test` and verify the TypeScript build passes.
