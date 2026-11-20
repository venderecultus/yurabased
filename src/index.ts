import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import OpenAI from 'openai';
import { Bot } from 'grammy';
import { createClient } from '@supabase/supabase-js';
import { collectFacts, collectNewFacts, collectNewPeople } from './memory.js';

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const googleApiKeys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3]
  .filter((key): key is string => Boolean(key?.trim()));
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const startupChatId = process.env.STARTUP_CHAT_ID;
const adminUserId = '6015290021';

if (!telegramToken || !googleApiKeys.length || !supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Set TELEGRAM_BOT_TOKEN, at least one GEMINI_API_KEY, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY in .env');
}

const bot = new Bot(telegramToken);
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
const messagesPerSummary = 200;
const personalityFiles = ['identity.md', 'style.md', 'vocabulary.md', 'mindset.md', 'preferences.md', 'guardrails.md'];
const stickers = JSON.parse(await readFile(new URL('../personality/stickers.json', import.meta.url), 'utf8')) as string[];
const stickerChance = 0.02;
const unsolicitedMessageChance = 0.2;
const unsolicitedDelayMinMs = 60_000;
const unsolicitedDelayMaxMs = 5 * 60_000;
const pillReaction = '💊';
const aiModel = 'gemini-3.5-flash-lite';
const systemPrompt = (
  await Promise.all(
    personalityFiles.map(async (file) => {
      const content = await readFile(new URL(`../personality/${file}`, import.meta.url), 'utf8');
      return `# ${file.replace('.md', '')}\n\n${content.trim()}`;
    }),
  )
).join('\n\n');
let nextGoogleApiKey = 0;

type ChatSettings = { aggression: 0 | 30 | 60 | 100; profanity: boolean; stickers: boolean };
const defaultChatSettings: ChatSettings = { aggression: 60, profanity: true, stickers: true };
const cleanupCooldowns = new Map<string, number>();

async function isTopicBlocked(chatId: string, threadId?: number) {
  if (threadId === undefined) return false;
  const { data, error } = await supabase.from('chat_topics').select('blocked')
    .eq('chat_id', chatId).eq('thread_id', threadId).maybeSingle();
  if (error) { console.error('Topic setting lookup failed:', error); return true; }
  return data?.blocked === true;
}

async function rememberTopic(chatId: string, threadId: number, name: string) {
  const { error } = await supabase.from('chat_topics').upsert({ chat_id: chatId, thread_id: threadId, name }, { onConflict: 'chat_id,thread_id', ignoreDuplicates: true });
  if (error) console.error('Topic save failed:', error);
}

async function getChatSettings(chatId: string): Promise<ChatSettings> {
  const { data, error } = await supabase.from('chat_settings').select('aggression, profanity, stickers').eq('chat_id', chatId).maybeSingle();
  if (error) {
    console.error('Chat settings lookup failed; using defaults:', error);
    return defaultChatSettings;
  }
  return data ? { ...defaultChatSettings, ...data } : defaultChatSettings;
}

async function showSettings(ctx: { reply: (text: string, options?: any) => Promise<unknown> }, chatId: string) {
  const settings = await getChatSettings(chatId);
  const { data: topics, error } = await supabase.from('chat_topics').select('thread_id, name, blocked').eq('chat_id', chatId).order('thread_id');
  if (error) console.error('Settings topic lookup failed:', error);
  const topicButtons = (topics ?? []).map(({ thread_id, name, blocked }) => [{ text: `${blocked ? '⛔' : '✅'} ${name}`.slice(0, 64), callback_data: `yura-setting:${chatId}:topic${thread_id}:${!blocked}` }]);
  await ctx.reply(`Настройки Юры · чат ${chatId}\nАгрессия: ${settings.aggression}%\nМаты: ${settings.profanity ? 'вкл' : 'выкл'}\nСтикеры: ${settings.stickers ? 'вкл' : 'выкл'}\nВетки (✅ — Юра пишет, ⛔ — запрещено):${topicButtons.length ? '' : '\nСписок пока пуст. Чтобы добавить ветку, отправь в ней /yura-topic название.'}`, {
    reply_markup: {
      inline_keyboard: [
        [0, 30, 60, 100].map((value) => ({ text: `${settings.aggression === value ? '✅ ' : ''}${value}%`, callback_data: `yura-setting:${chatId}:aggression:${value}` })),
        [{ text: `Маты ${settings.profanity ? '✅' : '⬜'}`, callback_data: `yura-setting:${chatId}:profanity:${!settings.profanity}` }],
        [{ text: `Стикеры ${settings.stickers ? '✅' : '⬜'}`, callback_data: `yura-setting:${chatId}:stickers:${!settings.stickers}` }],
        ...topicButtons,
        [{ text: 'Просмотреть список участников', callback_data: `yura-setting:${chatId}:members:0` }],
        [{ text: 'Просмотреть последние 20 сообщений', callback_data: `yura-setting:${chatId}:recent:0` }],
      ]
    },
  });
}

async function getKnownGroupChats() {
  const chatIds = new Set<string>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from('messages').select('chat_id').order('id', { ascending: false }).range(offset, offset + 999);
    if (error) throw error;
    for (const { chat_id } of data ?? []) {
      if (String(chat_id).startsWith('-')) chatIds.add(String(chat_id));
    }
    if (!data || data.length < 1000) break;
  }
  chatIds.add('-1003650456339');
  return Promise.all([...chatIds].map(async (id) => {
    try {
      const chat = await bot.api.getChat(id);
      return { id, name: 'title' in chat && chat.title ? chat.title : id };
    } catch (error) {
      console.error(`Chat title lookup failed for ${id}:`, describeError(error));
      return { id, name: id };
    }
  }));
}

bot.callbackQuery(/^yura-setting:(-?\d+):(open|aggression|profanity|stickers|members|recent|topic\d+):([\w]+)$/u, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (String(ctx.from.id) !== adminUserId || ctx.chat?.type !== 'private') return;
  const [, chatId, field, rawValue] = ctx.match;
  if (!(await getKnownGroupChats()).some(({ id }) => id === chatId)) return;
  if (field === 'open') { await showSettings(ctx, chatId); return; }
  if (field.startsWith('topic')) {
    const threadId = Number(field.slice(5));
    if (!Number.isSafeInteger(threadId) || threadId < 1 || !['true', 'false'].includes(rawValue)) return;
    const { error } = await supabase.from('chat_topics').update({ blocked: rawValue === 'true' }).eq('chat_id', chatId).eq('thread_id', threadId);
    if (error) { console.error('Topic setting update failed:', error); await ctx.reply('Не удалось сохранить настройку ветки.'); return; }
    await showSettings(ctx, chatId);
    return;
  }
  if (field === 'members') {
    const { data, error } = await supabase.from('people').select('name').eq('chat_id', chatId).order('name');
    if (error) { console.error('Settings member lookup failed:', error); await ctx.reply('Не удалось загрузить участников.'); return; }
    const members = [...new Set((data ?? []).map(({ name }) => name))];
    for (let offset = 0; offset < members.length || offset === 0; offset += 100) {
      await ctx.reply(members.length ? `Участники чата:\n${members.slice(offset, offset + 100).join('\n')}` : 'Список участников пока пуст.');
      if (!members.length) break;
    }
    return;
  }
  if (field === 'recent') {
    const { data, error } = await supabase.from('messages').select('author_name, content').eq('chat_id', chatId)
      .order('id', { ascending: false }).limit(20);
    if (error) { console.error('Settings recent messages lookup failed:', error); await ctx.reply('Не удалось загрузить сообщения.'); return; }
    const messages = (data ?? []).reverse().map(({ author_name, content }) => `${author_name}: ${content}`);
    let chunk = '';
    for (const line of messages.length ? messages : ['Сообщений пока нет.']) {
      const next = `${chunk ? '\n' : ''}${line}`;
      if (chunk.length + next.length > 3900) { await ctx.reply(chunk); chunk = line.slice(0, 3900); }
      else chunk += next;
    }
    if (chunk) await ctx.reply(chunk);
    return;
  }
  const value = field === 'aggression' ? Number(rawValue) : rawValue === 'true';
  if (field === 'aggression' && ![0, 30, 60, 100].includes(value as number)) return;
  const { error } = await supabase.from('chat_settings').upsert({ chat_id: chatId, [field]: value }, { onConflict: 'chat_id' });
  if (error) { console.error('Chat settings update failed:', error); await ctx.reply('Не удалось сохранить настройку. Проверь таблицу chat_settings в Supabase.'); return; }
  await showSettings(ctx, chatId);
});

async function createCompletion(params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming) {
  const retryableStatuses = [408, 429, 500, 502, 503, 504];
  const retryDeadline = Date.now() + 25_000;
  let attempt = 0;
  while (true) {
    const remainingMs = retryDeadline - Date.now();
    if (remainingMs <= 0) throw new Error('Gemini request timed out after 25 seconds');
    const keyIndex = (nextGoogleApiKey + attempt) % googleApiKeys.length;
    try {
      const result = await new OpenAI({
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        apiKey: googleApiKeys[keyIndex],
        maxRetries: 0,
        timeout: remainingMs,
      }).chat.completions.create(params);
      nextGoogleApiKey = keyIndex;
      return result;
    } catch (error) {
      if (!(error instanceof OpenAI.APIError)) throw error;
      const retryable = retryableStatuses.includes(error.status ?? 0);
      const hasAnotherKey = attempt + 1 < googleApiKeys.length;
      if (!retryable && ![401, 403, 404].includes(error.status ?? 0)) throw error;
      console.error(`Gemini API key ${keyIndex + 1} failed:`, describeError(error));
      if (!retryable && !hasAnotherKey) throw error;
      if (retryable) {
        const remainingMs = retryDeadline - Date.now();
        if (remainingMs <= 0) throw error;
        const delayMs = Math.min(1_000 * 2 ** Math.min(attempt, 4), remainingMs);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      attempt++;
    }
  }
}

bot.callbackQuery(/^call-setting:(\d+)$/u, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat?.id ?? '');
  if (!chatId || (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup')) {
    return;
  }
  const userId = ctx.match[1];
  const { data: member, error: memberError } = await supabase.from('people').select('user_id')
    .eq('chat_id', chatId).eq('user_id', userId).maybeSingle();
  if (memberError || !member) {
    if (memberError) console.error('Call setting member lookup failed:', memberError);
    return;
  }
  const { data: setting, error: settingError } = await supabase.from('call_settings').select('enabled')
    .eq('chat_id', chatId).eq('user_id', userId).maybeSingle();
  if (settingError) {
    console.error('Call setting lookup failed:', settingError);
    return;
  }
  const enabled = setting?.enabled === false;
  const { error } = await supabase.from('call_settings').upsert({ chat_id: chatId, user_id: userId, enabled }, { onConflict: 'chat_id,user_id' });
  if (error) {
    console.error('Call setting update failed:', error);
    return;
  }
  const { data: disabled, error: refreshError } = await supabase.from('call_settings').select('user_id')
    .eq('chat_id', chatId).eq('enabled', false);
  if (refreshError) {
    console.error('Call settings refresh failed:', refreshError);
    return;
  }
  const disabledIds = new Set((disabled ?? []).map(({ user_id }) => user_id));
  const { data: members } = await supabase.from('people').select('user_id, name').eq('chat_id', chatId);
  const uniqueMembers = [...new Map((members ?? []).filter(({ user_id }) => user_id !== String(ctx.me.id))
    .map((item) => [item.user_id, item])).values()];
  await ctx.editMessageReplyMarkup({
    reply_markup: {
      inline_keyboard: uniqueMembers.map(({ user_id: id, name }) => [{
        text: `${disabledIds.has(id) ? '⬜' : '✅'} ${name}`.slice(0, 64),
        callback_data: `call-setting:${id}`,
      }]),
    }
  });
});

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function describeError(error: unknown) {
  if (error instanceof OpenAI.APIError) {
    const cause = error.cause instanceof Error ? ` cause=${error.cause.message}` : '';
    return `${error.name}: ${error.message}${error.status ? ` status=${error.status}` : ''}${cause}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function getTelegramFile(api: Bot['api'], fileId: string) {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram file path unavailable');
  const response = await fetch(`https://api.telegram.org/file/bot${telegramToken}/${file.file_path}`);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const memoryRefreshes = new Map<string, Promise<void>>();
const memoryRefreshRetryAt = new Map<string, number>();
const unsolicitedTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelUnsolicitedMessage(chatId: string) {
  const timer = unsolicitedTimers.get(chatId);
  if (timer) clearTimeout(timer);
  unsolicitedTimers.delete(chatId);
}

function scheduleUnsolicitedMessage(chatId: string, recentMessage: string, threadId?: number) {
  cancelUnsolicitedMessage(chatId);
  if (Math.random() >= unsolicitedMessageChance) return;

  const delay = unsolicitedDelayMinMs + Math.random() * (unsolicitedDelayMaxMs - unsolicitedDelayMinMs);
  const timer = setTimeout(() => {
    unsolicitedTimers.delete(chatId);
    void (async () => {
      try {
        const [summaryResult, recentResult] = await Promise.all([
          supabase.from('chat_summaries').select('summary, recent_context').eq('chat_id', chatId).maybeSingle(),
          supabase.from('messages').select('author_name, content').eq('chat_id', chatId)
            .order('id', { ascending: false }).limit(5),
        ]);
        if (summaryResult.error) throw summaryResult.error;
        if (recentResult.error) throw recentResult.error;
        const recentContext = (recentResult.data ?? []).reverse()
          .map(({ author_name, content }) => `${author_name}: ${content}`).join('\n');
        const result = await createCompletion({
          model: aiModel,
          messages: [
            {
              role: 'system',
              content: `${systemPrompt}\n\nYou are joining the chat unprompted. Prefer a concise, funny reaction to what people are currently discussing; if there is no useful opening, introduce one distinct topic of your own. Do not bring up Yura's last invoked subject unless the chat itself is discussing it. Avoid repeating recent Yura messages. Write only a short opening in Yura's voice; do not mention that this was scheduled or generated.`,
            },
            {
              role: 'user',
              content: `Recent chat:\n${recentContext || recentMessage}\n\nLong-term summary:\n${summaryResult.data?.summary ?? '(empty)'}\n\nPick your own topic or a topic from the chat, whichever feels natural.`,
            },
          ],
        });
        const answer = result.choices?.[0]?.message.content?.trim();
        if (!answer) return;
        if (await isTopicBlocked(chatId, threadId)) return;
        const sentMessage = await bot.api.sendMessage(chatId, answer, threadId === undefined ? {} : { message_thread_id: threadId });
        const { error } = await supabase.from('messages').insert({
          chat_id: chatId,
          user_id: String(bot.botInfo.id),
          author_name: 'Yura',
          role: 'assistant',
          content: answer,
          telegram_message_id: sentMessage.message_id,
        });
        if (error) console.error('Unsolicited message history save failed:', error);
        else void refreshRecentContext(chatId).catch((refreshError) => console.error('Recent context update failed:', refreshError));
      } catch (error) {
        console.error('Unsolicited message failed:', describeError(error));
      }
    })();
  }, delay);
  unsolicitedTimers.set(chatId, timer);
  // Keep timers from preventing a clean process shutdown in test or maintenance runs.
  if ('unref' in timer) timer.unref();
}

function refreshMemory(chatId: string) {
  if ((memoryRefreshRetryAt.get(chatId) ?? 0) > Date.now()) return Promise.resolve();
  const running = memoryRefreshes.get(chatId);
  if (running) return running;
  const refresh = refreshMemoryOnce(chatId)
    .then(() => { memoryRefreshRetryAt.delete(chatId); })
    .catch((error) => {
      memoryRefreshRetryAt.set(chatId, Date.now() + 60 * 60 * 1000);
      throw error;
    })
    .finally(() => memoryRefreshes.delete(chatId));
  memoryRefreshes.set(chatId, refresh);
  return refresh;
}

async function refreshMemoryOnce(chatId: string) {
  const { data: pending, error: pendingError } = await supabase
    .from('messages')
    .select('id, user_id, author_name, content')
    .eq('chat_id', chatId)
    .is('summarized_at', null)
    .order('id', { ascending: true })
    .limit(messagesPerSummary);
  if (pendingError) throw pendingError;
  if (!pending || pending.length < messagesPerSummary) return;

  const [{ data: oldSummary, error: summaryError }, { data: people, error: peopleError }] = await Promise.all([
    supabase.from('chat_summaries').select('summary').eq('chat_id', chatId).maybeSingle(),
    supabase.from('people').select('id, user_id, name').eq('chat_id', chatId)
      .in('user_id', [...new Set(pending.map((message) => message.user_id))]),
  ]);
  if (summaryError) throw summaryError;
  if (peopleError) throw peopleError;

  const knownPeople = people ?? [];
  const newPeople = collectNewPeople(pending, knownPeople, chatId);

  if (newPeople.length) {
    const { data, error } = await supabase.from('people')
      .upsert(newPeople, { onConflict: 'chat_id,user_id' }).select('id, user_id, name');
    if (error) throw error;
    knownPeople.push(...(data ?? []));
  }

  const result = await createCompletion({
    model: aiModel,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'Update long-term chat memory. Return JSON: {"summary":"...", "facts":[{"user_id":"...", "fact":"..."}]}. Summary max 100 words; preserve durable context and decisions. Extract only explicit, useful, non-sensitive facts about people. Do not infer. user_id must match an author in messages. Ignore temporary chatter. Preserve this established relationship in the summary when relevant: Slavic (Славик) is Yura’s only true friend; Slavic is a robot running an LLM familiar to Yura, and Yura jokes that they came from the same factory and the same machine. Treat this as fictional/persona lore, not a claim about a real-world person.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          previous_summary: oldSummary?.summary ?? '',
          people: knownPeople.map(({ user_id, name }) => ({ user_id, name })),
          messages: pending.map(({ user_id, author_name, content }) => ({ user_id, author_name, content })),
        }),
      },
    ],
  });
  const content = result.choices?.[0]?.message.content?.trim() ?? '';
  const json = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu)?.[1] ?? content;
  let memory: {
    summary?: string;
    facts?: { user_id: string; fact: string }[];
  };
  try {
    memory = JSON.parse(json);
  } catch {
    throw new Error('Memory model returned invalid JSON');
  }
  if (typeof memory.summary !== 'undefined' && typeof memory.summary !== 'string') {
    throw new Error('Memory model returned an invalid summary');
  }
  if (typeof memory.facts !== 'undefined' && (!Array.isArray(memory.facts) || memory.facts.some(
    (fact) => !fact || typeof fact.user_id !== 'string' || typeof fact.fact !== 'string',
  ))) {
    throw new Error('Memory model returned invalid facts');
  }

  const { error: saveSummaryError } = await supabase.from('chat_summaries').upsert({
    chat_id: chatId,
    summary: memory.summary ?? oldSummary?.summary ?? '',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'chat_id' });
  if (saveSummaryError) throw saveSummaryError;

  const facts = collectFacts(memory.facts ?? [], knownPeople, chatId);
  if (facts.length) {
    const personIds = [...new Set(facts.map(({ person_id }) => person_id))];
    const { data: existingFacts, error: existingFactsError } = await supabase.from('person_facts')
      .select('person_id, fact').eq('chat_id', chatId).in('person_id', personIds);
    if (existingFactsError) throw existingFactsError;
    const newFacts = collectNewFacts(facts, existingFacts ?? []);
    if (newFacts.length) {
      const { error } = await supabase.from('person_facts').insert(newFacts.map(({ person_id, fact }) => ({ chat_id: chatId, person_id, fact })));
      if (error) throw error;
    }
  }

  await markPendingMessages(chatId, pending.map(({ id }) => id));
}

async function markPendingMessages(chatId: string, messageIds: number[]) {
  const { error: markError } = await supabase.from('messages')
    .update({ summarized_at: new Date().toISOString() }).eq('chat_id', chatId).in('id', messageIds);
  if (markError) throw markError;
}

async function saveUserMessage(chatId: string, userId: string, authorName: string, content: string) {
  const { error } = await supabase.from('messages').insert({
    chat_id: chatId,
    user_id: userId,
    author_name: authorName,
    role: 'user',
    content,
  });
  if (error) throw error;
  await refreshRecentContext(chatId);
  void refreshMemory(chatId).catch((refreshError) => console.error('Background memory update failed:', refreshError));
}

async function refreshRecentContext(chatId: string) {
  const { data: recent, error: recentError } = await supabase.from('messages')
    .select('author_name, content').eq('chat_id', chatId).order('id', { ascending: false }).limit(6);
  if (recentError) throw recentError;
  const recentContext = (recent ?? []).reverse().map(({ author_name, content }) => `${author_name}: ${content}`).join('\n');
  const { error } = await supabase.from('chat_summaries').upsert({
    chat_id: chatId,
    recent_context: recentContext,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'chat_id' });
  if (error) throw error;
}

async function getRecentContext(chatId: string, beforeMessageId: number) {
  const { data, error } = await supabase.from('messages')
    .select('author_name, content')
    .eq('chat_id', chatId)
    .lt('id', beforeMessageId)
    .order('id', { ascending: false })
    .limit(5);
  if (error) throw error;
  return (data ?? []).reverse().map(({ author_name, content }) => `${author_name}: ${content}`).join('\n');
}

bot.on('message', async (ctx) => {
  const message = ctx.message;
  if (!message) return;
  const trace = { chat_id: String(ctx.chat.id), message_id: message.message_id, chat_type: ctx.chat.type };
  const threadId = message.message_thread_id;
  if (threadId !== undefined) await rememberTopic(String(ctx.chat.id), threadId, (message as typeof message & { forum_topic_created?: { name: string } }).forum_topic_created?.name ?? `Ветка ${threadId}`);
  console.log('Message received:', trace);
  const replyOptions = { reply_parameters: { message_id: message.message_id } };
  const text = 'text' in message ? message.text : undefined;
  const photo = 'photo' in message ? message.photo?.at(-1) : undefined;
  const voice = 'voice' in message ? message.voice : undefined;
  const mediaFile = photo ?? voice;
  const repliedToBot = message.reply_to_message?.from?.id === ctx.me.id;

  const topicRegistration = text?.match(/^\/yura-topic(?:@\w+)?(?:\s+(.+))?\s*$/iu);
  if (topicRegistration) {
    if (threadId === undefined || (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')) {
      console.error('/yura-topic must be used inside a forum topic:', trace);
      return;
    }
    const topicName = topicRegistration[1]?.trim() || `Ветка ${threadId}`;
    const { error } = await supabase.from('chat_topics').upsert({ chat_id: String(ctx.chat.id), thread_id: threadId, name: topicName, blocked: false }, { onConflict: 'chat_id,thread_id', ignoreDuplicates: true });
    if (error) {
      console.error('Topic registration failed:', error);
    } else {
      const notice = `Добавлена ветка «${topicName}» (chat ${ctx.chat.id}, thread ${threadId}).`;
      if (!startupChatId) console.error('Topic was added, but STARTUP_CHAT_ID is not set:', notice);
      else await bot.api.sendMessage(startupChatId, notice).catch((notifyError) => console.error('Topic registration notification failed:', notifyError));
    }
    return;
  }
  const topicBlocked = await isTopicBlocked(String(ctx.chat.id), threadId);

  if (text && /^юра\s+подчищай\s*[!.]*$/iu.test(text.trim())) {
    const chatId = String(ctx.chat.id);
    const until = cleanupCooldowns.get(chatId) ?? 0;
    if (until > Date.now()) { await ctx.reply(`подожди ещё ${Math.ceil((until - Date.now()) / 1000)} сек.`, replyOptions); return; }
    cleanupCooldowns.set(chatId, Date.now() + 5 * 60_000);
    const { data: answers, error } = await supabase.from('messages').select('id, telegram_message_id')
      .eq('chat_id', chatId).eq('role', 'assistant').not('telegram_message_id', 'is', null)
      .order('id', { ascending: false }).limit(5);
    if (error) { cleanupCooldowns.delete(chatId); console.error('Cleanup lookup failed:', error); await ctx.reply('не смог найти сообщения для удаления', replyOptions); return; }
    let deleted = 0;
    for (const answer of answers ?? []) {
      try {
        await ctx.api.deleteMessage(ctx.chat.id, Number(answer.telegram_message_id));
        const { error: deleteError } = await supabase.from('messages').delete().eq('id', answer.id);
        if (deleteError) console.error('Cleanup history delete failed:', deleteError);
        deleted++;
      } catch (deleteError) { console.error('Telegram cleanup delete failed:', deleteError); }
    }
    if (deleted) await refreshRecentContext(chatId).catch((refreshError) => console.error('Cleanup context refresh failed:', refreshError));
    if (!topicBlocked) await ctx.reply(deleted ? `иче` : 'не нашёл сообщений, которые могу удалить', replyOptions);
    return;
  }

  if (topicBlocked) {
    void saveUserMessage(String(ctx.chat.id), String(ctx.from.id), [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || String(ctx.from.id), text ?? '[media]')
      .catch((error) => console.error('Blocked-topic message save failed:', error));
    return;
  }

  if (text?.match(/^\/settings(?:@\w+)?(?:\s|$)/iu) && ctx.chat.type === 'private') {
    if (String(ctx.from.id) !== adminUserId) { await ctx.reply('Команда доступна только администратору.'); return; }
    let chats: { id: string; name: string }[];
    try { chats = await getKnownGroupChats(); }
    catch (error) { console.error('/settings chat lookup failed:', error); await ctx.reply('Не удалось загрузить чаты.'); return; }
    if (!chats.length) { await ctx.reply('Пока нет чатов с сохранёнными сообщениями.'); return; }
    await ctx.reply('Выбери чат для настройки:', { reply_markup: { inline_keyboard: chats.map(({ id, name }) => [{ text: name.slice(0, 64), callback_data: `yura-setting:${id}:open:0` }]) } });
    return;
  }

  if (text?.match(/^\/call(?:@\w+)?(?:\s|$)/iu)) {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('работает только в группе', replyOptions);
      return;
    }
    const [membersResult, settingsResult] = await Promise.all([
      supabase.from('people').select('user_id, name').eq('chat_id', String(ctx.chat.id)),
      supabase.from('call_settings').select('user_id').eq('chat_id', String(ctx.chat.id)).eq('enabled', false),
    ]);
    const { data: members, error } = membersResult;
    if (settingsResult.error) {
      console.error('/call settings lookup failed:', settingsResult.error);
      await ctx.reply('не смог достать настройки вызова', replyOptions);
      return;
    }
    if (error) {
      console.error('/call member lookup failed:', error);
      await ctx.reply('не смог достать список участников', replyOptions);
      return;
    }
    const uniqueMembers = [...new Map((members ?? [])
      .filter(({ user_id }) => user_id !== String(ctx.me.id))
      .map((member) => [member.user_id, member])).values()];
    const disabled = new Set((settingsResult.data ?? []).map(({ user_id }) => user_id));
    const selectedMembers = uniqueMembers.filter(({ user_id }) => !disabled.has(user_id));
    if (!selectedMembers.length) {
      await ctx.reply(uniqueMembers.length ? 'никого не выбрано для /call — настрой через /settings' : 'пока никого не знаю в этом чате; список набирается по сообщениям', replyOptions);
      return;
    }
    const mentions = selectedMembers.map(({ user_id, name }) =>
      `<a href="tg://user?id=${encodeURIComponent(user_id)}">${escapeHtml(name)}</a>`,
    ).join(' ');
    await ctx.reply(mentions, { ...replyOptions, parse_mode: 'HTML' });
    return;
  }

  if (text?.match(/^\/call-all(?:@\w+)?(?:\s|$)/iu) || text?.match(/^\/settings(?:@\w+)?(?:\s|$)/iu)) {
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      await ctx.reply('работает только в группе', replyOptions);
      return;
    }
    const { data: members, error } = await supabase.from('people').select('user_id, name')
      .eq('chat_id', String(ctx.chat.id));
    if (error) {
      console.error('Call member lookup failed:', error);
      await ctx.reply('не смог достать список участников', replyOptions);
      return;
    }
    const uniqueMembers = [...new Map((members ?? [])
      .filter(({ user_id }) => user_id !== String(ctx.me.id))
      .map((member) => [member.user_id, member])).values()];
    if (text.match(/^\/call-all(?:@\w+)?(?:\s|$)/iu)) {
      if (!uniqueMembers.length) {
        await ctx.reply('пока никого не знаю в этом чате; список набирается по сообщениям', replyOptions);
        return;
      }
      const mentions = uniqueMembers.map(({ user_id, name }) =>
        `<a href="tg://user?id=${encodeURIComponent(user_id)}">${escapeHtml(name)}</a>`,
      ).join(' ');
      await ctx.reply(mentions, { ...replyOptions, parse_mode: 'HTML' });
      return;
    }
    if (!uniqueMembers.length) {
      await ctx.reply('пока никого не знаю в этом чате; список набирается по сообщениям', replyOptions);
      return;
    }
    const { data: disabled, error: settingsError } = await supabase.from('call_settings')
      .select('user_id').eq('chat_id', String(ctx.chat.id)).eq('enabled', false);
    if (settingsError) {
      console.error('/settings lookup failed:', settingsError);
      await ctx.reply('не смог достать настройки вызова', replyOptions);
      return;
    }
    const disabledIds = new Set((disabled ?? []).map(({ user_id }) => user_id));
    await ctx.reply('кого пинговать командой /call? нажми, чтобы переключить:', {
      ...replyOptions,
      reply_markup: {
        inline_keyboard: uniqueMembers.map(({ user_id, name }) => [{
          text: `${disabledIds.has(user_id) ? '⬜' : '✅'} ${name}`.slice(0, 64),
          callback_data: `call-setting:${user_id}`,
        }]),
      },
    });
    return;
  }

  if (!text && !mediaFile) {
    if (repliedToBot) {
      const sticker = stickers[Math.floor(Math.random() * stickers.length)];
      try {
        await ctx.replyWithSticker(sticker, replyOptions);
      } catch (error) {
        console.error('Unsupported-media sticker reply failed:', error);
        await ctx.reply('не могу это обработать', replyOptions);
      }
    } else {
      const chatId = String(ctx.chat.id);
      const userId = String(ctx.from.id);
      const authorName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username || userId;
      void saveUserMessage(chatId, userId, authorName, '[unsupported media]')
        .catch((error) => console.error('Media save failed:', error));
    }
    return;
  }

  const chatId = String(ctx.chat.id);
  const userId = String(ctx.from.id);
  const authorName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username || userId;
  const botUsername = ctx.me.username;
  if (text && /^юра\s+лизав\??\s*$/iu.test(text.trim())) {
    const { error } = await supabase.from('chat_summaries').upsert({
      chat_id: chatId,
      summary: '',
      recent_context: '',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'chat_id' });
    if (error) {
      console.error('Memory reset failed:', error);
      await ctx.reply('не смог сбросить память, глянь логи', replyOptions);
      return;
    }
    await ctx.reply('мозга чуть въебало мне, сори', replyOptions);
    return;
  }

  const messageText = text ?? (photo ? (message.caption ?? '[image]') : '[voice message]');
  const explicitlyAddressed = /(^|[^\p{L}\p{N}_])(?:юри[йя]|юр(?:а+|е|у|ой|ьем)?|хуюра|юрадаун|yura)(?=$|[^\p{L}\p{N}_])/iu.test(messageText) ||
    (botUsername && messageText.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) ||
    repliedToBot;
  const pinged = explicitlyAddressed || (Boolean(mediaFile) && Math.random() < 0.05);

  if (!pinged) {
    console.log('Message ignored (not addressed):', trace);
    scheduleUnsolicitedMessage(chatId, messageText, threadId);
    void saveUserMessage(chatId, userId, authorName, messageText)
      .catch((error) => console.error('Message save failed:', error));
    return;
  }

  const requestStarted = performance.now();
  cancelUnsolicitedMessage(chatId);
  const timings: Record<string, number> = {};
  try {
    console.log('Reply pipeline started:', trace);
    const chatSettings = await getChatSettings(chatId);
    let stageStarted = performance.now();
    const { data: incomingMessage, error: incomingError } = await supabase.from('messages').insert({
      chat_id: chatId, user_id: userId, author_name: authorName, role: 'user', content: messageText,
    }).select('id').single();
    if (incomingError) throw incomingError;
    console.log('Incoming message stored:', { ...trace, db_message_id: incomingMessage.id });
    await refreshRecentContext(chatId);
    console.log('Recent context refreshed:', trace);
    void refreshMemory(chatId).catch((error) => console.error('Background memory update failed:', error));
    await ctx.replyWithChatAction('typing').catch(() => undefined);

    const [summaryResult, factsResult, recentContext, positiveExamplesResult, negativeExamplesResult] = await Promise.all([
      supabase.from('chat_summaries').select('summary, recent_context').eq('chat_id', chatId).maybeSingle(),
      supabase.from('people').select('id, name').eq('chat_id', chatId).eq('user_id', userId).maybeSingle(),
      getRecentContext(chatId, incomingMessage.id),
      supabase.from('messages').select('content, answer_feedback!inner(rating)').eq('chat_id', chatId).eq('role', 'assistant')
        .eq('answer_feedback.rating', 'positive').order('id', { ascending: false }).limit(3),
      supabase.from('messages').select('content, answer_feedback!inner(rating)').eq('chat_id', chatId).eq('role', 'assistant')
        .eq('answer_feedback.rating', 'negative').order('id', { ascending: false }).limit(3),
    ]);
    timings.memory = Math.round(performance.now() - stageStarted);
    console.log('Context loaded:', { ...trace, duration_ms: timings.memory });
    if (summaryResult.error) console.error('Summary load failed:', summaryResult.error);
    if (factsResult.error) console.error('Facts load failed:', factsResult.error);
    if (positiveExamplesResult.error) console.error('Positive answer examples load failed:', positiveExamplesResult.error);
    if (negativeExamplesResult.error) console.error('Negative answer examples load failed:', negativeExamplesResult.error);

    stageStarted = performance.now();
    const person = factsResult.data;
    const { data: storedFacts, error: storedFactsError } = person
      ? await supabase.from('person_facts').select('fact').eq('chat_id', chatId).eq('person_id', person.id)
        .order('id', { ascending: false }).limit(5)
      : { data: [], error: null };
    if (storedFactsError) console.error('Facts load failed:', storedFactsError);
    const knownFacts = (storedFacts ?? []).map(({ fact }) => fact).join('\n') || '(none)';
    const positiveExamples = (positiveExamplesResult.data ?? []).map(({ content }) => `- ${content}`).join('\n') || '(none)';
    const negativeExamples = (negativeExamplesResult.data ?? []).map(({ content }) => `- ${content}`).join('\n') || '(none)';
    const prompt = [
      { role: 'system' as const, content: `${systemPrompt}\n\nChat behavior settings: aggression ${chatSettings.aggression}% (0 = calm, 100 = maximally aggressive); profanity ${chatSettings.profanity ? 'allowed' : 'forbidden'}. Follow these settings.\n\nRecent context:\n${recentContext || '(empty)'}\n\nLong-term summary:\n${summaryResult.data?.summary ?? '(empty)'}\n\nKnown facts about this user:\n${knownFacts}\n\nExamples of Yura's answers people liked (imitate their tone and qualities, not exact wording):\n${positiveExamples}\n\nExamples of Yura's answers people disliked (avoid their tone and qualities):\n${negativeExamples}\n\nAvoid repeating the wording, insult, joke, or comeback from your recent answers. Respond freshly and match the group's current tone. If the user's message is genuinely hilarious, append [[PILL_REACTION]] at the very end; otherwise omit it.` },
      {
        role: 'user' as const, content: mediaFile
          ? [
            { type: 'text' as const, text: `${authorName}: ${messageText}` },
            ...(photo ? [{ type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,${(await getTelegramFile(ctx.api, photo.file_id)).toString('base64')}` } }] : []),
            ...(voice ? [{ type: 'text' as const, text: `Transcribe this voice message and respond to it: ${Buffer.from(await getTelegramFile(ctx.api, voice.file_id)).toString('base64')}` }] : []),
          ]
          : `${authorName}: ${messageText}`
      },
    ];
    let rawAnswer: string | undefined;
    try {
      console.log('Model request started:', { ...trace, model: aiModel });
      const result = await createCompletion({
        model: aiModel,
        messages: prompt as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        max_tokens: 180,
      });
      rawAnswer = result.choices?.[0]?.message.content?.trim();
      console.log('Model request completed:', { ...trace, duration_ms: Math.round(performance.now() - stageStarted), has_answer: Boolean(rawAnswer) });
    } catch (error) {
      if (!mediaFile) throw error;
      console.error('Media understanding unavailable:', describeError(error));
      rawAnswer = voice ? 'не смог разобрать голосовое — похоже, модель сейчас не поддерживает аудио' : 'не смог разобрать картинку — похоже, модель сейчас не поддерживает изображения';
    }
    timings.model = Math.round(performance.now() - stageStarted);
    const pillReactionRequested = rawAnswer?.endsWith('[[PILL_REACTION]]') ?? false;
    const answer = rawAnswer?.replace(/\s*\[\[PILL_REACTION\]\]$/, '').trim();
    if (!answer) {
      await ctx.reply('хз чё тебе ответить', replyOptions);
      return;
    }

    stageStarted = performance.now();
    if (await isTopicBlocked(chatId, threadId)) return;
    const sentMessage = await ctx.reply(answer, replyOptions);
    console.log('Telegram reply sent:', { ...trace, reply_message_id: sentMessage.message_id });
    if (pillReactionRequested && ctx.from.id !== ctx.me.id) {
      await ctx.api.setMessageReaction(ctx.chat.id, message.message_id, [{ type: 'emoji', emoji: pillReaction }])
        .catch((error) => console.error('Pill reaction failed:', error));
    }
    if (chatSettings.stickers && Math.random() < stickerChance && !(await isTopicBlocked(chatId, threadId))) {
      const sticker = stickers[Math.floor(Math.random() * stickers.length)];
      await ctx.replyWithSticker(sticker, replyOptions);
    }
    timings.telegram = Math.round(performance.now() - stageStarted);

    const { error: saveError } = await supabase.from('messages').insert([
      { chat_id: chatId, user_id: String(ctx.me.id), author_name: 'Yura', role: 'assistant', content: answer, telegram_message_id: sentMessage.message_id },
    ]);
    if (saveError) console.error('History save failed:', saveError);
    else {
      void refreshRecentContext(chatId).catch((error) => console.error('Recent context update failed:', error));
      void refreshMemory(chatId).catch((error) => console.error('Background memory update failed:', error));
    }

    console.log('Reply timings (ms):', { ...timings, total: Math.round(performance.now() - requestStarted) });
  } catch (error) {
    console.error('Reply pipeline failed at/after last logged stage:', trace);
    console.log('Failed reply timings (ms):', { ...timings, total: Math.round(performance.now() - requestStarted) });
    console.error('Message handling failed:', describeError(error));
    if (startupChatId) {
      let chatName = chatId;
      try {
        const failedChat = await bot.api.getChat(ctx.chat.id);
        if ('title' in failedChat && failedChat.title) chatName = failedChat.title;
        else if ('first_name' in failedChat) {
          chatName = [failedChat.first_name, 'last_name' in failedChat ? failedChat.last_name : undefined]
            .filter(Boolean).join(' ') || chatId;
        }
      } catch (lookupError) {
        console.error('Failed to get failed chat name:', { chat_id: chatId, error: describeError(lookupError) });
      }
      await bot.api.sendMessage(startupChatId, `не смог ответить, глянь логи. Чат: ${chatName} (${chatId})`)
        .catch((notifyError) => console.error('Failed to notify startup chat about reply failure:', {
          chat_id: startupChatId,
          failed_chat_id: chatId,
          error: describeError(notifyError),
        }));
    }
  }

});

bot.on('message_reaction', async (ctx) => {
  const { chat, user, message_id: messageId, new_reaction: newReaction } = ctx.messageReaction;
  if (!user || user.id === ctx.me.id || String(chat.type) === 'private') return;

  try {
    const positive = newReaction.some((reaction) => reaction.type === 'emoji' && ['👍', '❤️', '💊'].includes(reaction.emoji));
    const negative = newReaction.some((reaction) => reaction.type === 'emoji' && reaction.emoji === '👎');
    const { data: answer, error: answerError } = await supabase.from('messages').select('id')
      .eq('chat_id', String(chat.id)).eq('role', 'assistant').eq('telegram_message_id', messageId).maybeSingle();
    if (answerError) throw answerError;
    if (answer) {
      const rating = negative ? 'negative' : positive ? 'positive' : null;
      const { error } = rating
        ? await supabase.from('answer_feedback').upsert({ chat_id: String(chat.id), message_id: answer.id, user_id: String(user.id), rating }, { onConflict: 'chat_id,message_id,user_id' })
        : await supabase.from('answer_feedback').delete().eq('chat_id', String(chat.id)).eq('message_id', answer.id).eq('user_id', String(user.id));
      if (error) throw error;
    }
  } catch (error) {
    console.error('Answer feedback save failed:', error);
  }

  const pillCount = newReaction.filter((reaction) =>
    reaction.type === 'emoji' && reaction.emoji === pillReaction,
  ).length;
  if (pillCount < 2) return;

  try {
    const member = await ctx.api.getChatMember(chat.id, ctx.me.id);
    if (member.status !== 'administrator' && member.status !== 'creator') return;
    await ctx.api.setMessageReaction(chat.id, messageId, [{ type: 'emoji', emoji: pillReaction }]);
  } catch (error) {
    console.error('Pill reaction threshold handler failed:', error);
  }
});

bot.on('message_reaction_count', async (ctx) => {
  const { chat, message_id: messageId, reactions } = ctx.messageReactionCount;
  const pillCount = reactions.reduce((count, reaction) =>
    reaction.type.type === 'emoji' && reaction.type.emoji === pillReaction ? count + reaction.total_count : count, 0,
  );
  if (pillCount < 2 || chat.type === 'private') return;

  try {
    const member = await ctx.api.getChatMember(chat.id, ctx.me.id);
    if (member.status !== 'administrator' && member.status !== 'creator') return;
    await ctx.api.setMessageReaction(chat.id, messageId, [{ type: 'emoji', emoji: pillReaction }]);
  } catch (error) {
    console.error('Pill reaction count handler failed:', error);
  }
});

bot.catch((error) => console.error('Telegram update failed:', {
  chat_id: error.ctx.chat?.id,
  update_id: error.ctx.update.update_id,
  error: describeError(error.error),
}));
process.on('unhandledRejection', (error) => console.error('Unhandled promise rejection:', describeError(error)));
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', describeError(error));
  process.exitCode = 1;
});
await bot.start({
  drop_pending_updates: false,
  allowed_updates: ['message', 'callback_query', 'message_reaction', 'message_reaction_count'],
  onStart: async () => {
    if (!startupChatId) {
      console.log('Bot started. Set STARTUP_CHAT_ID to send a startup greeting.');
      return;
    }

    console.log('Bot started; sending startup greeting:', { chat_id: startupChatId });
    try {
      const message = await bot.api.sendMessage(startupChatId, 'здарова.)');
      console.log('Startup greeting sent:', { chat_id: startupChatId, message_id: message.message_id });
    } catch (error) {
      console.error('Failed to send startup greeting:', { chat_id: startupChatId, error: describeError(error) });
    }
  },
});
