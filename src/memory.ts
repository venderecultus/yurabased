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
