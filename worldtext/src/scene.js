// SCENE IS AN EPHEMERAL QUERY RESULT (§19–20).
//
// A scene is not a container of world objects. It is a temporary activation of
// world material, compiled downstream from meaning: situation → semantic query →
// ripe potentials → the few processes that must exist → projection. Throw it
// away and the world is untouched.

import { frontier, semanticSlice, LOD } from './activate.js';
import { field } from './potential.js';
import { wake } from './agent.js';
import { EPISTEMIC } from './worldtext.js';

export function compileScene(world, situation = {}) {
  const branch = situation.branch || 'CANON';
  const front = frontier(world, situation);
  // Being *relevant* to a place is not the same as *standing in* it. Only the
  // people the source actually locates here are present; everyone else is
  // merely someone the question made worth thinking about.
  const present = situation.present?.length
    ? situation.present
    : (situation.place ? locatedAt(world, situation.place, branch) : []);

  const slice = semanticSlice(world, front, { branch });
  const ripe = field(world, { ...situation, present }, { branch });

  const scene = {
    id: `scene_${world.clock}_${Math.abs(hash(JSON.stringify(situation)))}`,
    branch,
    situation: { ...situation, present },
    place: situation.place || null,
    frontier: front,
    slice,
    potentials: ripe,
    agents: [],
    events: [],

    /** Instantiate only the processes interaction actually requires (§12). */
    instantiate(ids = null) {
      const want = ids || front.active.filter((a) => a.lod >= LOD.AGENT && a.kind === 'person').map((a) => a.id);
      for (const id of want) {
        if (scene.agents.some((a) => a.personId === id)) continue;
        scene.agents.push(wake(world, id, { ...situation, present, branch }));
      }
      return scene.agents;
    },

    agentFor(id) { return scene.agents.find((a) => a.personId === id) || null; },

    /**
     * Fire a ripe potential. This is a deliberate operation, never automatic —
     * the motor recognises pressure, it does not pull every trigger (§70).
     */
    enact(potentialId, { caption = null, author = 'motor' } = {}) {
      const ev = ripe.find((e) => e.potential.id === potentialId);
      if (!ev) throw new Error(`potential ${potentialId} is not in this scene`);
      if (!ev.ripe) throw new Error(`potential ${potentialId} is not ripe: ${ev.unmet.map((u) => u.why).join('; ')}`);
      const p = ev.potential;
      const event = world.append({
        kind: p.kind,
        place: p.place || situation.place || null,
        participants: p.participants,
        witnesses: present,
        branch,
        caption: caption || p.because,
        causedBy: [p.id],
        provenance: { potential: p.id, from: p.from, author },
      });
      p.status = 'spent';
      p.firedAs.push(event.id);
      scene.events.push(event);
      world.note('enact', { potential: p.id, event: event.id });
      return event;
    },

    /** Everything the scene created goes home; the scene itself does not persist. */
    dissolve() {
      for (const a of scene.agents) a.sleep();
      scene.agents = [];
      return { events: scene.events.map((e) => e.id) };
    },
  };
  return scene;
}

/** Who does the corpus place here? Work, routine, ownership, or avoidance-of. */
function locatedAt(world, placeId, branch) {
  const out = new Set();
  for (const st of world.about(placeId, { branch })) {
    if (!['RUNS', 'OWNS', 'WORKS_AT', 'ATTENDS'].includes(st.predicate)) continue;
    const who = st.subject === placeId ? st.object : st.subject;
    const e = world.entities.get(who);
    if (e && (e.kind === 'person' || e.kind === 'group')) out.add(who);
  }
  return [...out];
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * WRITEBACK (§42). New experience returns to WorldText as structured history
 * plus readable language — sharing one event identity, so a future scene can be
 * compiled from what just happened.
 */
export function writeback(world, event, { asStatements = true } = {}) {
  const nameOf = (id) => world.entities.get(id)?.names[0] || id;
  const line = event.caption || `${event.participants.map(nameOf).join(' and ')} — ${event.kind}`;
  if (asStatements) {
    for (const p of event.participants) {
      const st = world.assert({
        kind: 'memory', epistemic: EPISTEMIC.MEMORY, holder: p, subject: p,
        predicate: 'REMEMBERS', object: line, branch: event.branch,
        provenance: { eventId: event.id },
        confidence: event.witnesses.includes(p) ? 0.9 : 0.5,
      });
      event.statements.push(st.id);
    }
  }
  return { line, eventId: event.id };
}
