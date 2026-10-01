import assert from 'node:assert/strict';
import test from 'node:test';
import { collectFacts, collectNewPeople } from './memory.js';

test('collectNewPeople deduplicates pending users and excludes known users', () => {
  const people = [{ id: 1, user_id: 'known', name: 'Known' }];
  const messages = [
    { user_id: 'known', author_name: 'Known', content: 'already saved' },
    { user_id: 'new', author_name: 'New Person', content: 'first' },
    { user_id: 'new', author_name: 'New Person', content: 'again' },
  ];

  assert.deepEqual(collectNewPeople(messages, people, 'chat'), [
    { chat_id: 'chat', user_id: 'new', name: 'New Person' },
  ]);
});

test('collectFacts trims facts and discards unknown people and blank facts', () => {
  const people = [{ id: 2, user_id: 'known', name: 'Known' }];
  const facts = [
    { user_id: 'known', fact: '  durable detail  ' },
    { user_id: 'known', fact: '  ' },
    { user_id: 'unknown', fact: 'not attributable' },
  ];

  assert.deepEqual(collectFacts(facts, people, 'chat'), [
    { chat_id: 'chat', person_id: 2, fact: 'durable detail' },
  ]);
});
