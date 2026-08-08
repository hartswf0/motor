#!/usr/bin/env node
// THE LORE BIBLE IS THE IDE (§37). One prompt, no menus, no viewport.
//
//   node motor.js                 the demo world
//   node motor.js path/to/dir     any directory of .md / .txt
//   node motor.js --demo          the five-minute demonstration (§122), scripted
//
// With ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_HOST set, the motor will
// escalate the sentences its rules could not parse, and let characters phrase
// their own answers — everything else runs identically without one.

import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { loadDir } from './src/load.js';
import { ask, asPerson, provenance, disputes, reasonsToVisit, namesIn } from './src/query.js';
import { compileScene, writeback } from './src/scene.js';
import { prose, film, timeline, map, playable } from './src/project.js';
import { field } from './src/potential.js';
import { fromEnv, getModel, modelUsage } from './src/model.js';
import { indexWithModel } from './src/parse.js';

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dir = args[0] && existsSync(args[0]) ? args[0] : new URL('./corpus', import.meta.url).pathname;

const { world, report, potentials } = loadDir(dir);
const adapter = fromEnv();

let here = null;          // current place
let scene = null;

console.log(bold('\nWORLDTEXT MOTOR'));
console.log(dim(`${world.corpus.size()} passages · ${world.entities.size} named things · ${world.statements.size} statements · ${potentials.length} potentials`));
console.log(dim(`${report.parsed} sentences parsed by rule, ${report.unparsed} left as source only`));
console.log(dim(adapter ? `model available for escalation: ${adapter.name}` : 'no model configured — running the deterministic path (§81)'));
console.log(dim('\ntry:  what is disputed?   ·   ask Miriam about the flood   ·   take me to the mill'));
console.log(dim('      what could matter here?   ·   why is that true?   ·   film it   ·   what exists?\n'));

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '_ ' });
rl.prompt();

rl.on('line', async (raw) => {
  const line = raw.trim();
  if (!line) return rl.prompt();
  try { await handle(line); } catch (e) { console.log(dim(`  ${e.message}`)); }
  rl.prompt();
});

async function handle(line) {
  const l = line.toLowerCase();

  if (/^(quit|exit)$/.test(l)) { rl.close(); process.exit(0); }

  // §146 — the final falsification question
  if (/^what exists\??$/.test(l)) {
    scene?.dissolve(); scene = null;
    console.log(cyan('  Every viewport closed, every agent terminated. What is still there:'));
    const c = world.census();
    console.log(`  ${c.passages} source passages, exactly as written`);
    console.log(`  ${c.entities} people and places (${Object.entries(c.byKind).map(([k, v]) => `${v} ${k}`).join(', ')})`);
    console.log(`  ${c.statements} statements (${Object.entries(c.byEpistemic).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ')})`);
    console.log(`  ${c.events} events, ${c.potentials} potentials, ${c.branches} branch(es), clock ${c.clock}`);
    if (getModel()) console.log(dim(`  model calls so far: ${JSON.stringify(modelUsage().escalations)}`));
    return;
  }

  if (/^escalate/.test(l)) {
    if (!getModel()) return console.log(dim('  no model configured; set ANTHROPIC_API_KEY, OPENAI_API_KEY or OLLAMA_HOST'));
    console.log(dim('  escalating unparsed sentences…'));
    const r = await indexWithModel(world, { limit: 40 });
    console.log(`  attempted ${r.attempted}, admitted ${r.admitted} (as GENERATED), refused ${r.refused}`);
    for (const x of r.refusals.slice(0, 5)) console.log(dim(`    refused: ${x.verdict || ''} ${x.why}`));
    return;
  }

  // take me to X
  let m = /^(?:take me to|go to|enter)\s+(?:the\s+)?(.+?)\??$/i.exec(line);
  if (m) {
    const ids = namesIn(world, m[1]);
    const place = ids.map((id) => world.entities.get(id)).find((e) => e?.kind === 'place');
    if (!place) return console.log(dim(`  nothing named "${m[1]}" is a place in this corpus`));
    here = place.id;
    scene?.dissolve();
    scene = compileScene(world, { place: here, question: m[1] });
    const view = playable(world, scene);
    console.log(cyan(`  ${place.names[0]}`));
    for (const q of world.entities.get(here).mentions.slice(0, 3)) {
      console.log(`    “${world.corpus.quote(q).text}”  ${dim(world.corpus.quote(q).citation)}`);
    }
    if (view.present.length) console.log(`  here: ${view.present.map((p) => p.name).join(', ')}`);
    const ripe = scene.potentials.filter((e) => e.ripe);
    if (ripe.length) console.log(`  ${bold('ripe:')} ${ripe.map((e) => e.potential.because).join(' · ')}`);
    const waiting = scene.potentials.filter((e) => !e.ripe).slice(0, 3);
    for (const w of waiting) console.log(dim(`  dormant: ${w.potential.because} — waiting for ${w.unmet.map((u) => u.why).join(', ')}`));
    return;
  }

  // ask N about X
  m = /^ask\s+(\w[\w' -]*?)\s+(?:about\s+)?(.+?)\??$/i.exec(line);
  if (m) {
    const ids = namesIn(world, m[1]);
    const person = ids.map((id) => world.entities.get(id)).find((e) => e?.kind === 'person');
    if (!person) return console.log(dim(`  nobody named "${m[1]}" is in this corpus`));
    const situation = { place: here, present: [person.id, ...(scene?.situation.present || [])].slice(0, 4) };
    if (getModel()) {
      const { wake } = await import('./src/agent.js');
      const agent = wake(world, person.id, situation);
      const a = await agent.answerVoiced(m[2]);
      console.log(`  ${bold(person.names[0])}: ${a.text}`);
      console.log(dim(`    [${a.type}${a.phrased ? `, phrased by ${a.modelId}` : ''}${a.refusedPhrasing ? `; phrasing refused: ${a.refusedPhrasing.join('; ')}` : ''}]`));
      for (const b of a.basis.slice(0, 3)) {
        const q = b.passage ? world.corpus.quote(b.passage) : null;
        if (q) console.log(dim(`    from “${q.text}” — ${q.citation} (${b.path})`));
      }
      agent.say(a.text);
      agent.sleep();
    } else {
      const a = asPerson(world, person.id, m[2], situation);
      console.log(`  ${bold(person.names[0])}: ${a.text.replace(`${person.names[0]}: `, '')}`);
      console.log(dim(`    [${a.type}; context ${JSON.stringify(a.contextSize)}]`));
      for (const b of a.basis.slice(0, 3)) {
        const q = b.passage ? world.corpus.quote(b.passage) : null;
        if (q) console.log(dim(`    from “${q.text}” — ${q.citation} (${b.path})`));
      }
      if (a.withheld) console.log(dim('    [holds something back]'));
    }
    return;
  }

  // enact / play the ripe potential
  if (/^(enact|play it|let it happen|stage it)/.test(l)) {
    if (!scene) return console.log(dim('  no scene is compiled — take me somewhere first'));
    const ripe = scene.potentials.find((e) => e.ripe);
    if (!ripe) return console.log(dim('  nothing here is ripe'));
    const ev = scene.enact(ripe.potential.id);
    writeback(world, ev);
    console.log(cyan(`  ${ev.caption}`));
    console.log(dim(`    event ${ev.id} · caused by ${ev.causedBy.join(', ')} · witnesses ${ev.witnesses.length}`));
    return;
  }

  if (/^film/.test(l)) {
    const f = film(world, { seconds: 60 });
    if (!f.shots.length) return console.log(dim('  nothing has happened yet to film'));
    for (const s of f.shots) console.log(`  ${s.n}. ${bold(s.slug)}  ${dim(`${s.seconds}s ${s.framing}`)}\n     ${s.action}`);
    console.log(dim(`  (${f.shots.length} shots over the same ${f.events.length} events — no second story was written)`));
    return;
  }
  if (/^(timeline|history)/.test(l)) {
    const t = timeline(world);
    if (!t.length) return console.log(dim('  no events yet'));
    for (const r of t) console.log(`  t${r.t}  ${r.what}  ${dim(r.where || '')}`);
    return;
  }
  if (/^map/.test(l)) {
    const mp = map(world);
    for (const e of mp.edges) console.log(`  ${world.entities.get(e.from)?.names[0]} ${dim(e.relation)} ${world.entities.get(e.to)?.names[0]}`);
    console.log(dim(`  ${mp.note}`));
    return;
  }
  if (/^(narrate|what happened)/.test(l)) return console.log(`  ${prose(world)}`);

  // everything else goes to the world's own inspector
  const a = ask(world, line, { place: here });
  console.log(`  ${a.text.split('\n').join('\n  ')}`);
  if (a.kind === 'field' && a.potentials?.length) {
    console.log(dim(`  (${a.potentials.length} potentials weighed; none fired — potential is not event)`));
  }
}
