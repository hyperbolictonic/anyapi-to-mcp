// Level-1 example: render a payload, then read an address back out of it.
//
// Run with: node examples/view-quickstart.ts
//
// No map, no network, no files. This is the whole "app builder imports the
// library" story for the view layer: hand it JSON you already have.

import { readAt, renderView } from '../src/index.ts';

const payload = {
  total_count: 1240,
  items: Array.from({ length: 12 }, (_, i) => ({
    number: i + 1,
    title: `Issue ${i + 1}`,
    state: i % 3 === 0 ? 'closed' : 'open',
    user: { login: `user${i + 1}`, id: i + 1 },
    labels: [{ name: 'bug' }, { name: 'help wanted' }],
    comments: i * 2,
  })),
};

const envelope = renderView(
  payload,
  {
    select: '/items',
    mode: 'rows',
    fields: ['number', 'title', 'state', 'user.login', 'comments'],
    limits: { maxItems: 5 },
  },
  { provenance: 'human' },
);

if (!envelope.ok) {
  console.error(envelope.error);
  process.exit(1);
}

console.log(JSON.stringify(envelope.value, null, 2));
console.log();

const hint = envelope.value.hint ?? '';
const next = /read (\S+) (\S+)/.exec(hint)?.[2];
console.log(`envelope: ${envelope.value.bytes} bytes, ${envelope.value.returned}/${envelope.value.total} rows`);
console.log(`summary:  ${envelope.value.summary}`);
console.log(`hint:     ${hint}`);

if (next) {
  const followUp = readAt(payload, next);
  console.log(`read ${next} ->`, followUp.ok ? JSON.stringify(followUp.value.node) : followUp.error.message);
}
