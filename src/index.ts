import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import OpenAI from 'openai';
import { Bot } from 'grammy';
import { createClient } from '@supabase/supabase-js';

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const routerApiKey = process.env.OPENROUTER_API_KEY;
const openaiBaseUrl = process.env.OPENAI_BASE_URL;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const startupChatId = process.env.STARTUP_CHAT_ID;

if (!telegramToken || !routerApiKey || !openaiBaseUrl || !supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Set TELEGRAM_BOT_TOKEN, OPENROUTER_API_KEY, OPENAI_BASE_URL, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY in .env');
}

const bot = new Bot(telegramToken);
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
const messagesPerSummary = 20;
const personalityFiles = ['identity.md', 'style.md', 'vocabulary.md', 'mindset.md', 'preferences.md', 'guardrails.md'];
const stickers = JSON.parse(await readFile(new URL('../personality/stickers.json', import.meta.url), 'utf8')) as string[];
const stickerChance = 0.15;
const pillReaction = '💊';
const systemPrompt = (
  await Promise.all(
    personalityFiles.map(async (file) => {
      const content = await readFile(new URL(`../personality/${file}`, import.meta.url), 'utf8');
      return `# ${file.replace('.md', '')}\n\n${content.trim()}`;
    }),
  )
).join('\n\n');
const ai = new OpenAI({
  baseURL: openaiBaseUrl,
  apiKey: routerApiKey,
  timeout: 60_000,
  maxRetries: 1,
});

const memoryRefreshes = new Map<string, Promise<void>>();

function refreshMemory(chatId: string) {
  const running = memoryRefreshes.get(chatId);
  if (running) return running;
  const refresh = refreshMemoryOnce(chatId).finally(() => memoryRefreshes.delete(chatId));
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
  const newPeople = pending
    .filter((message, index, all) => all.findIndex((item) => item.user_id === message.user_id) === index)
    .filter((message) => !knownPeople.some((person) => person.user_id === message.user_id))
    .map((message) => ({ chat_id: chatId, user_id: message.user_id, name: message.author_name }));

  if (newPeople.length) {
    const { data, error } = await supabase.from('people')
      .upsert(newPeople, { onConflict: 'chat_id,user_id' }).select('id, user_id, name');
    if (error) throw error;
    knownPeople.push(...(data ?? []));
  }

  const result = await ai.chat.completions.create({
    model: 'gemini/gemini-3.1-flash-lite-preview',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'Update long-term chat memory. Return JSON: {"summary":"...", "facts":[{"user_id":"...", "fact":"..."}]}. Summary max 100 words; preserve durable context and decisions. Extract only explicit, useful, non-sensitive facts about people. Do not infer. user_id must match an author in messages. Ignore temporary chatter.',
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
  const memory = JSON.parse(result.choices[0]?.message.content ?? '{}') as {
    summary?: string;
    facts?: { user_id: string; fact: string }[];
  };

  const { error: saveSummaryError } = await supabase.from('chat_summaries').update({
    summary: memory.summary ?? oldSummary?.summary ?? '',
    updated_at: new Date().toISOString(),
  }).eq('chat_id', chatId);
  if (saveSummaryError) throw saveSummaryError;

  const facts = (memory.facts ?? []).flatMap(({ user_id, fact }) => {
    const person = knownPeople.find((entry) => entry.user_id === user_id);
    return person && fact.trim() ? [{ chat_id: chatId, person_id: person.id, fact: fact.trim() }] : [];
  });
  if (facts.length) {
    const { error } = await supabase.from('person_facts').insert(facts);
    if (error) throw error;
  }

  const { error: markError } = await supabase.from('messages')
    .update({ summarized_at: new Date().toISOString() }).in('id', pending.map(({ id }) => id));
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
  const replyOptions = { reply_parameters: { message_id: message.message_id } };
  const text = 'text' in message ? message.text : undefined;
  const repliedToBot = message.reply_to_message?.from?.id === ctx.me.id;

  if (!text) {
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
  if (/^юра\s+лизав\??\s*$/iu.test(text.trim())) {
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

  const pinged = /(^|[^\p{L}\p{N}_])(?:юри[йя]|юр(?:а+|е|у|ой|ьем)?|хуюра|юрадаун|yura)(?=$|[^\p{L}\p{N}_])/iu.test(text) ||
    (botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) ||
    repliedToBot;

  if (!pinged) {
    void saveUserMessage(chatId, userId, authorName, text)
      .catch((error) => console.error('Message save failed:', error));
    return;
  }

  const requestStarted = performance.now();
  const timings: Record<string, number> = {};
  try {
    let stageStarted = performance.now();
    const { data: incomingMessage, error: incomingError } = await supabase.from('messages').insert({
      chat_id: chatId, user_id: userId, author_name: authorName, role: 'user', content: text,
    }).select('id').single();
    if (incomingError) throw incomingError;
    await refreshRecentContext(chatId);
    void refreshMemory(chatId).catch((error) => console.error('Background memory update failed:', error));
    await ctx.replyWithChatAction('typing').catch(() => undefined);

    const [summaryResult, factsResult, recentContext] = await Promise.all([
      supabase.from('chat_summaries').select('summary, recent_context').eq('chat_id', chatId).maybeSingle(),
      supabase.from('person_facts').select('fact, people!inner(name, user_id)').eq('chat_id', chatId)
        .eq('people.user_id', userId)
        .order('id', { ascending: false }).limit(12),
      getRecentContext(chatId, incomingMessage.id),
    ]);
    timings.memory = Math.round(performance.now() - stageStarted);
    if (summaryResult.error) console.error('Summary load failed:', summaryResult.error);
    if (factsResult.error) console.error('Facts load failed:', factsResult.error);

    stageStarted = performance.now();
    const knownFacts = (factsResult.data ?? []).map((row) => {
      const person = row.people as unknown as { name: string } | null;
      return `${person?.name ?? 'unknown'}: ${row.fact}`;
    }).join('\n') || '(none)';
    const result = await ai.chat.completions.create({
      model: 'gemini/gemini-3.1-flash-lite-preview',
      messages: [
        {
          role: 'system',
          content: `${systemPrompt}\n\nOngoing chat context (recent messages):\n${recentContext || '(empty)'}\n\nLong-term chat summary:\n${summaryResult.data?.summary ?? '(empty)'}\n\nKnown facts about this user:\n${knownFacts}`,
        },
        {
          role: 'user',
          content: `${authorName}: ${text}\n\nIf the user's message is genuinely hilarious, append the exact marker [[PILL_REACTION]] at the very end of your response. Otherwise do not append it. Judge laughter-worthy humor strictly; don't mark mildly amusing messages.`,
        },
      ],
    });
    timings.model = Math.round(performance.now() - stageStarted);
    const rawAnswer = result.choices[0]?.message.content?.trim();
    const pillReactionRequested = rawAnswer?.endsWith('[[PILL_REACTION]]') ?? false;
    const answer = rawAnswer?.replace(/\s*\[\[PILL_REACTION\]\]$/, '').trim();
    if (!answer) {
      await ctx.reply('хз чё тебе ответить', replyOptions);
      return;
    }

    stageStarted = performance.now();
    await ctx.reply(answer, replyOptions);
    if (pillReactionRequested && ctx.from.id !== ctx.me.id) {
      await ctx.api.setMessageReaction(ctx.chat.id, message.message_id, [{ type: 'emoji', emoji: pillReaction }])
        .catch((error) => console.error('Pill reaction failed:', error));
    }
    if (Math.random() < stickerChance) {
      const sticker = stickers[Math.floor(Math.random() * stickers.length)];
      await ctx.replyWithSticker(sticker, replyOptions);
    }
    timings.telegram = Math.round(performance.now() - stageStarted);

    const { error: saveError } = await supabase.from('messages').insert([
      { chat_id: chatId, user_id: String(ctx.me.id), author_name: 'Yura', role: 'assistant', content: answer },
    ]);
    if (saveError) console.error('History save failed:', saveError);
    else {
      void refreshRecentContext(chatId).catch((error) => console.error('Recent context update failed:', error));
      void refreshMemory(chatId).catch((error) => console.error('Background memory update failed:', error));
    }

    console.log('Reply timings (ms):', { ...timings, total: Math.round(performance.now() - requestStarted) });
  } catch (error) {
    console.log('Failed reply timings (ms):', { ...timings, total: Math.round(performance.now() - requestStarted) });
    console.error('Message handling failed:', error);
    await ctx.reply('не смог ответить, глянь логи', replyOptions);
  }

});

bot.on('message_reaction', async (ctx) => {
  const { chat, user, message_id: messageId, new_reaction: newReaction } = ctx.messageReaction;
  if (!user || user.id === ctx.me.id || String(chat.type) === 'private') return;

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

bot.catch((error) => console.error('Telegram update failed:', error));
await bot.start({
  allowed_updates: ['message', 'message_reaction', 'message_reaction_count'],
  onStart: async () => {
    if (!startupChatId) {
      console.log('Bot started. Set STARTUP_CHAT_ID to send a startup greeting.');
      return;
    }

    try {
      await bot.api.sendMessage(startupChatId, 'здарова.)');
    } catch (error) {
      console.error('Failed to send startup greeting:', error);
    }
  },
});
