// THE LOOP — looking before speaking, and looking again when surprised.
//
// One shot at a paragraph of context is not how anyone decides anything about a
// place. You look, you measure, you test, and if a measurement surprises you,
// you look again. This runs that: the model asks the world questions, the world
// answers with numbers, and only when it calls `propose` does anything reach a
// person.
//
// It is provider-agnostic on purpose. `complete` is any function that takes a
// conversation and returns either tool calls or text, so the same loop runs
// against a real endpoint, against a stub in a test, or against a transcript
// being replayed. That is what makes it testable without a key — the loop is
// the thing that can be wrong, and it can be wrong without any model at all.

import { TOOLS, runTool } from './tools.js';

/**
 * @param {World} world
 * @param {string} request        what the person said
 * @param {object} opts
 * @param {(msgs:Array, tools:Array) => Promise<{calls?:Array, text?:string}>} opts.complete
 * @param {number} opts.maxTurns  how many times it may look before it must speak
 * @param {(event:object) => void} opts.onStep   so the world can show its working
 */
export async function runLoop(world, request, {
  complete, maxTurns = 8, onStep = () => {}, situation = {}, budgetMs = 60000,
} = {}) {
  if (typeof complete !== 'function') throw new Error('the loop needs a `complete` function');

  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: framing(request, situation) },
  ];
  const looked = [];
  const started = Date.now();

  for (let turn = 0; turn < maxTurns; turn++) {
    if (Date.now() - started > budgetMs) {
      return finish(looked, null, `stopped after ${turn} looks — it was taking too long`);
    }
    const reply = await complete(messages, TOOLS);
    const calls = reply?.calls || [];

    if (!calls.length) {
      // it answered in prose without proposing: acceptable, but say so
      return finish(looked, null, reply?.text || 'nothing came back');
    }

    messages.push({ role: 'assistant', calls });

    for (const call of calls) {
      if (call.name === 'propose') {
        const result = runTool(world, 'propose', call.arguments);
        onStep({ kind: 'propose', call, result });
        return finish(looked, result, result.sentence);
      }
      const result = runTool(world, call.name, call.arguments || {});
      looked.push({ tool: call.name, arguments: call.arguments || {}, result });
      onStep({ kind: 'tool', call, result, turn });
      messages.push({ role: 'tool', name: call.name, content: JSON.stringify(result) });
    }

    // A model that asks the same question twice has stopped learning. Say so
    // rather than letting it spend the budget going round.
    const repeated = sameTwice(looked);
    if (repeated) {
      messages.push({
        role: 'user',
        content: `You have asked ${repeated} the same way twice and been given the same answer. `
          + 'Either ask something different, or propose what you have.',
      });
    }
  }

  return finish(looked, null, `looked ${looked.length} times without proposing anything`);
}

function finish(looked, proposal, text) {
  return {
    proposal,
    text,
    looked,
    // the trail is the point: every number in the answer can be traced to the
    // question that produced it
    evidence: looked.map((l) => ({ asked: l.tool, args: l.arguments, got: summarise(l.result) })),
  };
}

function sameTwice(looked) {
  if (looked.length < 2) return null;
  const key = (l) => `${l.tool}:${JSON.stringify(l.arguments)}`;
  const last = key(looked[looked.length - 1]);
  for (let i = 0; i < looked.length - 1; i++) if (key(looked[i]) === last) return looked[looked.length - 1].tool;
  return null;
}

function summarise(r) {
  if (!r || typeof r !== 'object') return r;
  if (r.error) return `error: ${r.error}`;
  const bits = [];
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) bits.push(`${k}=${v.length}`);
    else if (typeof v === 'object') continue;
    else bits.push(`${k}=${v}`);
  }
  return bits.slice(0, 6).join(' ');
}

const SYSTEM = `You are working inside a model of a real place, not a chat about one.

You cannot see the place. You can only ask it questions, and it answers with
measurements it computed — not recalled, not estimated. Use them.

How to work:
- Look before you speak. If you are about to state a fact about this place that
  no tool gave you, that is a fact you are inventing. Ask instead.
- Ask the cheap questions first: look, ground, measure. Run flood and seat when
  the answer actually turns on them.
- If a measurement surprises you, ask a second question rather than explaining
  the surprise away.
- When you have enough, call propose exactly once. Quote the numbers you were
  given, with their units, in "because".
- If the world tells you something cannot be computed, say that plainly. Do not
  substitute a plausible number.

You are not the authority here. Geometry decides; you propose, and a person
accepts or refuses. Never claim something has been done.`;

function framing(request, situation) {
  const bits = [`Someone said: "${request}"`];
  if (situation.at) bits.push(`They are pointing at [${situation.at.map((n) => Math.round(n)).join(', ')}].`);
  if (situation.selection?.length) bits.push(`They have selected: ${situation.selection.join(', ')}.`);
  if (situation.region) bits.push(`They have drawn a region of ${Math.round(situation.region)} m².`);
  if (situation.camera) bits.push(`They are looking at [${situation.camera.map((n) => Math.round(n)).join(', ')}].`);
  bits.push('Find out what you need, then propose.');
  return bits.join('\n');
}
