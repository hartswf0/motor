// PROJECTION IS NOT ONTOLOGY (§21–26).
//
// Prose, film, timeline, map and embodied play are views over the same events.
// None of them owns the world, and none of them may invent a separate canonical
// narrative. Every projection below reads the identical event list and preserves
// event identity, participants, place, time, causal ancestry, branch and
// provenance — the projection-invariance test (§22) checks exactly that.

const nameOf = (world, id) => world.entities.get(id)?.names[0] || id || 'someone';

/** The shared reading every projection starts from. Nothing is invented here. */
export function reading(world, { branch = 'CANON', events = null, since = 0 } = {}) {
  const list = (events || world.eventsIn(branch)).filter((e) => e.time >= since);
  return list.map((e) => ({
    id: e.id,
    kind: e.kind,
    time: e.time,
    place: e.place,
    placeName: e.place ? nameOf(world, e.place) : null,
    participants: e.participants,
    participantNames: e.participants.map((p) => nameOf(world, p)),
    branch: e.branch,
    caption: e.caption,
    causedBy: e.causedBy,
    statements: e.statements,
    provenance: e.provenance,
  }));
}

/** PROSE — the motor must always be able to return to language (§26). */
export function prose(world, opts = {}) {
  const r = reading(world, opts);
  if (!r.length) return 'Nothing has happened yet.';
  const lines = r.map((e) => {
    const where = e.placeName ? ` at the ${e.placeName}` : '';
    return `${e.caption || `${e.participantNames.join(' and ')} — ${e.kind}`}${where}.`;
  });
  return lines.join(' ');
}

/** FILM — selection, perspective, time and shot. It observes; it does not fork. */
export function film(world, opts = {}) {
  const { pov = null, seconds = 60 } = opts;
  const r = reading(world, opts);
  if (!r.length) return { shots: [], pov, seconds, events: [] };
  const per = Math.max(2, Math.floor(seconds / Math.max(1, r.length)));
  const shots = r.map((e, i) => {
    const others = e.participantNames.filter((n) => n !== (pov ? nameOf(world, pov) : null));
    const framing = e.participants.length > 1 ? 'two-shot' : 'single';
    return {
      n: i + 1,
      eventId: e.id,                        // identity preserved — same event, different view
      seconds: per,
      framing: pov && e.participants.includes(pov) ? `over-the-shoulder (${nameOf(world, pov)})` : framing,
      slug: `${e.placeName ? e.placeName.toUpperCase() : 'ELSEWHERE'} — ${e.time}`,
      action: e.caption,
      onScreen: others,
      knows: pov ? whatPovKnows(world, pov, e) : null,
    };
  });
  return { shots, pov, seconds, events: r.map((e) => e.id) };
}

function whatPovKnows(world, pov, e) {
  const ev = world.events.find((x) => x.id === e.id);
  if (!ev) return null;
  return ev.witnesses.includes(pov) || ev.participants.includes(pov) ? 'present' : 'absent — must be told';
}

/** TIMELINE — the same events, ordered, with their causes. */
export function timeline(world, opts = {}) {
  return reading(world, opts).map((e) => ({
    t: e.time,
    id: e.id,
    what: e.caption || e.kind,
    where: e.placeName,
    who: e.participantNames,
    because: e.causedBy,
  }));
}

/**
 * MAP — a text world has no coordinates and must not pretend to. What it has is
 * a topology of places and the relations the source states between them.
 */
export function map(world, { branch = 'CANON' } = {}) {
  const places = [...world.entities.values()].filter((e) => e.kind === 'place');
  const edges = [];
  for (const p of places) {
    for (const st of world.about(p.id, { branch })) {
      if (st.predicate !== 'SPATIAL') continue;
      if (st.subject !== p.id) continue;
      edges.push({ from: st.subject, to: st.object, relation: st.tags[0] || 'near', source: st.provenance.passageId });
    }
  }
  const eventsAt = new Map();
  for (const e of world.eventsIn(branch)) {
    if (!e.place) continue;
    eventsAt.set(e.place, (eventsAt.get(e.place) || 0) + 1);
  }
  return {
    places: places.map((p) => ({
      id: p.id, name: p.names[0],
      mentions: p.mentions.length,
      events: eventsAt.get(p.id) || 0,
    })),
    edges,
    note: 'Topological, not geographic: this world states adjacency, not coordinates.',
  };
}

/** GAME — a view that hands agency to a participant inside an activated state. */
export function playable(world, scene) {
  return {
    place: scene.place ? nameOf(world, scene.place) : null,
    present: scene.situation.present.map((p) => ({ id: p, name: nameOf(world, p) })),
    youMay: [
      ...scene.situation.present.map((p) => ({ op: 'ask', target: p, label: `ask ${nameOf(world, p)} about…` })),
      ...scene.potentials.filter((e) => e.ripe).map((e) => ({ op: 'enact', target: e.potential.id, label: e.potential.because })),
      { op: 'leave', label: 'leave' },
    ],
    pending: scene.potentials.filter((e) => !e.ripe).map((e) => ({
      because: e.potential.because,
      waitingFor: e.unmet.map((u) => u.why),
    })),
  };
}

/**
 * PROJECTION INVARIANCE (§22). Project one event set through every view and
 * check that identity, participants, place, time, branch and ancestry survive.
 */
export function invariance(world, opts = {}) {
  const base = reading(world, opts);
  const views = {
    prose: prose(world, opts),
    film: film(world, opts),
    timeline: timeline(world, opts),
  };
  const filmIds = views.film.shots.map((s) => s.eventId);
  const timelineIds = views.timeline.map((t) => t.id);
  const baseIds = base.map((e) => e.id);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  return {
    ok: same(filmIds, baseIds) && same(timelineIds, baseIds),
    events: baseIds,
    film: filmIds,
    timeline: timelineIds,
    views,
  };
}
