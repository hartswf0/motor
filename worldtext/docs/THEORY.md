# WORLDTEXT MOTOR — the theory before the code

## Pass B — what the previous system actually believed

CREO's code believed **a world is a set of geometric entities on a terrain, and
language is a way of editing them.** Every claim it made about provenance and
epistemics was true, but it hung off polygons. Turn off the renderer and the
world was a database needed to reconstruct a scene. §146 says that is not enough.

It also believed **grounding means coordinates** — that a place is real because
it has a latitude. With no API and no real locations, that belief has nothing to
stand on.

## The correction

**A world is a body of description capable of producing consequences.**

Grounding is not geographic. Grounding is *provenance*: every statement in the
world can name the passage, event, model or person it came from. A sentence in a
notebook is as real a foundation as a survey point, and considerably more honest
about being an interpretation.

## Laws for this build

1. **The source is sacred.** Exact language, stable identity, never replaced by
   extraction, summary or embedding. Extraction is a cache over source.
2. **Generated invention may not counterfeit source.** Every statement carries an
   epistemic status, and only explicit operations may promote it.
3. **No dormant person requires a live agent process.** A person persists; an
   agent wakes, acts, writes back, and is destroyed.
4. **Existence is semantic; activation is computational.** A woman named once on
   page 312 exists. She does not tick.
5. **Potential is not event.** A latent difference is indexed, ranked, and left
   dormant until conditions converge.
6. **Contradiction is world material.** Two incompatible accounts stay two
   accounts. The motor answers "what happened?" with the disagreement.
7. **Knowledge is situated.** No God's-eye flattening: a claim has a holder, a
   memory has a rememberer, a rumour has a path.
8. **No projection owns the world.** Prose, film, map, timeline, simulation and
   embodied play are views over one event ledger.

## Invariants (machine-checkable, in `tests/run.js`)

- Destroying every active agent leaves every person, history and relation
  recoverable.
- Turning off every projection leaves the world able to receive events, run
  processes, branch and answer queries.
- No foundation model is required for retrieval, activation, rules, simulation,
  branching, replay or projection. (There is none in this build at all.)
- A character cannot state a fact they have no path to know, unless the statement
  is typed as guess, lie, rumour or inference.
- Every derived statement resolves to a source passage, an event, or a model run.
- 10 000 possible people require O(relevant) active agents, not O(all).

## What is moving

Not meshes. Differences capable of producing consequences:

> estrangement · an unpaid debt · a secret with one holder · two incompatible
> dates for the same closure · a promise · a scheduled encounter · water against
> a barrier · a door someone will not walk through

The motor's job is to notice these, keep them asleep, and wake the few that the
present situation makes consequential.
