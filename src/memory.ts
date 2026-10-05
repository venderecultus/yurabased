export interface Message {
  user_id: string;
  author_name: string;
  content: string;
}

export interface Person {
  id: number;
  user_id: string;
  name: string;
}

export function selectNonRepeatingAnswer(answer: string, recentAnswers: string[]) {
  const candidate = normalizeAnswer(answer);
  if (!candidate) return false;
  return !recentAnswers.some((recent) => answerSimilarity(candidate, normalizeAnswer(recent)) >= 0.8);
}

export function collectNewFacts(
  facts: { person_id: number; fact: string }[],
  existingFacts: { person_id: number; fact: string }[],
) {
  const known = new Set(existingFacts.map(({ person_id, fact }) => `${person_id}:${normalizeFact(fact)}`));
  const added = new Set<string>();
  return facts.flatMap(({ person_id, fact }) => {
    const normalized = fact.trim();
    const key = `${person_id}:${normalizeFact(normalized)}`;
    if (!normalized || known.has(key) || added.has(key)) return [];
    added.add(key);
    return [{ person_id, fact: normalized }];
  });
}

function normalizeFact(fact: string) {
  return fact.toLocaleLowerCase('ru').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function normalizeAnswer(answer: string) {
  return answer.toLocaleLowerCase('ru').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function answerSimilarity(left: string, right: string) {
  if (left === right) return 1;
  const leftWords = new Set(left.split(/\s+/u).filter(Boolean));
  const rightWords = new Set(right.split(/\s+/u).filter(Boolean));
  if (!leftWords.size || !rightWords.size) return 0;
  const intersection = [...leftWords].filter((word) => rightWords.has(word)).length;
  return intersection / (leftWords.size + rightWords.size - intersection);
}

export function collectNewPeople(messages: Message[], knownPeople: Person[], chatId: string) {
  const knownIds = new Set(knownPeople.map(({ user_id }) => user_id));
  const seenIds = new Set<string>();

  return messages.flatMap(({ user_id, author_name }) => {
    if (knownIds.has(user_id) || seenIds.has(user_id)) return [];
    seenIds.add(user_id);
    return [{ chat_id: chatId, user_id, name: author_name }];
  });
}

export function collectFacts(
  facts: { user_id: string; fact: string }[],
  people: Person[],
  chatId: string,
) {
  const peopleByUserId = new Map(people.map((person) => [person.user_id, person]));
  return facts.flatMap(({ user_id, fact }) => {
    const person = peopleByUserId.get(user_id);
    const normalizedFact = fact.trim();
    return person && normalizedFact
      ? [{ chat_id: chatId, person_id: person.id, fact: normalizedFact }]
      : [];
  });
}
