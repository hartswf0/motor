# The gauntlet

Each pass: observe, name the deepest failure, state the invariant, make the
invariant structurally true, run the magic test, run the adversarial test,
convene the critics, take the lowest score, remove what the improvement made
obsolete, re-run every previous invariant, demonstrate.

The record below is the build itself. Nothing here is a plan; every entry is a
failure that was found by running the system and a change that was made because
of it.

---

## Pass 1 — nothing existed

**Deepest failure.** There was no world model, so there was nothing for language
to operate on.

**Invariant.** *After this pass it must be impossible for any subsystem —
renderer, simulation, query, history, export — to read a world other than the
one canonical PlaceModel.*

**Change.** `Place` + `Journal` + `SpatialIndex` + derived relations, wired
together in `World` so the index and the relation graph cannot drift from the
model. Every mutation is a journal entry with before/after snapshots.

**Demonstrated by.** *PRO E · save/reload fingerprint identity*, *PRO F · 100
mixed operations undone and redone exactly*.

---

## Pass 2 — "here" was a guess

**Deepest failure.** Reference resolution was going to be the difference between
a product and a demo, and a naive implementation would silently pick the wrong
thing — which is worse than refusing.

**Invariant.** *After this pass it must be impossible for a reference to resolve
without reporting the basis it used, and impossible for an unresolvable
reference to be resolved anyway.*

**Change.** `src/lang/deixis.js` resolves from selection, gesture, camera,
pointer, GPS, landmarks, scene graph and utterance history, returns `basis[]`
with every answer, and returns `AMBIGUOUS_REFERENCE` with a question when it
cannot tell.

**Demonstrated by.** *"behind this" flips side with the camera*; *"here" with
nothing indicated refuses to guess*; *"where we were before" reuses the previous
resolution*.

---

## Pass 3 — generation could ignore the world

**Deepest failure.** A generator that places geometry without querying the place
produces an AI scene sitting on top of a map.

**Invariant.** *After this pass it must be impossible for generated geometry to
ignore previously committed geometry — including geometry moved by hand.*

**Change.** Generation became a world query (`findPlacement`, `alignmentAt`,
`windowCorridors`) feeding a plan, gated by `certify()`. Ghosts, then the
certificate, then consequence, then commit.

**Adversarial test that changed the design.** Pointing at an occupied spot made
the generator quietly search for free ground nearby — a silent relocation, which
§12 forbids. Fixed: a **tap is a location, a circle is a search space**. Pointing
at a house now builds on the house and reports `COLLISION` naming it.

**Demonstrated by.** *PRO C*, *PRO C2 · no silent nudging*, *generation 2 cannot
ignore generation 1*, *manual edits are visible to later language operations*.

---

## Pass 4 — the drain was decoration

**Deepest failure.** Asked for a drain at the bottom of the flooded bowl, the
generator walked the terrain gradient — and the bowl is a local minimum, so the
walk terminated after one step. It produced a 3 m stub that changed the water
model by 0.0%. The system was answering with a gesture at drainage rather than
drainage.

**Invariant.** *After this pass it must be impossible for a drainage proposal to
exist without a real outfall, a graded invert, and a route around what is already
built — or an explicit finding saying it has none.*

**Change.** `findOutfall()` looks for somewhere the water can actually go;
`routeAcross()` (A\* with a climb penalty, over a coarse grid blocked by
structures) gets it there; the trench carries `props.invert` and the water model
interpolates the bed along its length. A swale, which is meant to hold water
rather than convey it, is laid on the contour instead and is not asked to find an
outfall.

**Result.** The three futures for the flooded ground stopped being decorative:

| | flooded area | deepest |
|---|---|---|
| As it is | 2914 m² | 0.31 m |
| Drainage first | 2592 m² | 0.26 m |
| Absorb it here | 2585 m² | 0.23 m |
| Move what floods | 2914 m² | 0.31 m *(by design — it accepts the water)* |

**Also fixed here.** Narrow linear features fell between the water grid's cells;
they are now stamped by distance to their centreline. And the A\* open set was a
sorted array, which took the pathfinder from 2 ms to minutes on the settlement —
now a binary heap.

---

## Pass 5 — naming a thing was read as asking for one

**Deepest failure.** The canonical sentence from the brief — *"when the rain is
bad, all of this fills with water"* — was compiled to **PROPOSE: New structure**.
The interpreter treated any mention of a noun as a request for one. This is the
thesis failing at its first sentence: testimony was being converted into
construction.

**Invariant.** *After this pass it must be impossible for a declarative statement
about the place to become geometry. Only an explicit asking verb — or a bare
elliptical phrase like "trees here" — may build.*

**Change.** `interpret.js` distinguishes declarative from imperative before it
reaches PROPOSE, and the observation lexicon learned the ways people actually
describe water.

**Demonstrated by.** *naming a thing is not asking for one* — eight sentences,
four testimony, four requests.

---

## Pass 6 — the network was fiction

**Deepest failure.** Connectivity read 14%. The lanes of the settlement did not
reach the road, three cross-paths ran straight through houses, and junctions were
tested between centrelines — so a 1.8 m lane touching a 7 m road was not a
junction because their centrelines were 4 m apart.

**Invariant.** *After this pass it must be impossible for two networks whose
surfaces meet to be treated as unconnected, and impossible for the seeded place
to contain paths drawn through solid buildings.*

**Change.** Junction reach now includes both widths. Graph node heights follow
the terrain rather than the entity's base, so two lanes that plainly cross on
sloping ground form a junction. The settlement's cross-paths are laid out by the
same A\* the design tools use, so they weave between the houses.

**Result.** 94% connectivity, and the remaining severed edges are real: lanes
genuinely clipped by buildings — including the one a resident says has not been
passable for years.

---

## Pass 7 — the roof hid the room

**Deepest failure.** At room scale the house was an opaque box. The interior —
rooms, partition, furniture, openings — existed in the model and was invisible.

**Invariant.** *After this pass it must be impossible to work at room scale
without seeing the room.*

**Change.** Structures containing the camera target are drawn without their roof
when you are close. Scale decides what is shown, as it already decided what is
loaded.

---

## Pass 8 — the council ran, and it was right

Eleven critics were given the running system and told to judge what exists. They
found eleven defects by running it, not by reading it. Every one is now a test in
`tests/run.js` → *council — regressions from critic round 1*.

| Found by | Defect | Fix |
|---|---|---|
| Computer scientist | A module-global id counter meant loading one save rewound the allocator for every other place in the process; two worlds then minted the same id and one silently overwrote the other | Ids are allocated per `Place` |
| Computer scientist | Undoing the creation of the branch you were standing in left `activeBranch` pointing at a deleted overlay; the next edit threw and the world was unrecoverable | Undo re-seats you on the nearest surviving ancestor and re-parents orphans |
| Computer scientist | `fingerprint()` — the instrument the save and undo invariants are measured with — ignored name, material, author, collision, props and evidence. It called "City Hall" and "prank shed" the same world | Fingerprint covers every field a person could lose, and every vertex |
| Architect | `WIDEN` scaled along world X/Y instead of the entity's own axis, shearing every rotated building into a parallelogram — and the certificate never noticed, because it checks area and collision, not shape | `G.scaleInFrame()`; a test asserts the result is still a rectangle |
| Simulation engineer | The water grid was re-derived from `place.bounds()` on each call, so a proposal poking outside those bounds shifted the origin for the whole place — a shed on dry ground 80 m from any puddle moved the reported flood area | One frame, computed from the union of world and ghosts, shared by both runs; `compareWater` now refuses runs on different grids |
| Simulation engineer | 90 iterations was a number tuned to look right, and "steady state" was the wrong question — run to convergence and the ground drains, because that bowl sits on a slope and is not a closed basin | The model is now an explicit rainfall **event**: rain arrives over the stated duration and the reported figure is the peak, because "it fills with water" describes an hour, not an equilibrium |
| GIS | `certify()` skipped the overlap check entirely for anything with `collision:'none'`, so a garden with a house's own footprint certified as **VALID** | Occupation is checked for every ghost; severity is proportionate to how much of a building it actually sits on |
| GIS | `shrinkToFree` and `findPlacement` tested a hardcoded 0–3 m z-window, which missed every building standing on ground above 3 m — most of them | Both test a window around the ground at that point |
| Planner | Branch strategies never went through `certify()`. One landed on top of House 22, contributed nothing, and appeared in the comparison table as "changes nothing" — a failed placement presented with the same confidence as a real verdict | Every strategy is certified before it is offered; rejected ones are named, with the reason |
| Planner | Three drainage strategies were offered for ground with no water problem | Strategies are chosen from what the ground does: the water model and the testimony recorded there |
| GIS | The code promised GeoJSON export; no exporter existed | `src/world/export.js`, with provenance and epistemic state on every feature, round-tripping to sub-millimetre |
| Game designer | "heavy rain", "at night" and "taller" were each claimed by two lexicon families; the tagger masks on first match, so the second token never fired and the two headline features were unreachable by the phrasing people actually use | Lexicon de-duplicated; `lexiconCollisions()` is exported and asserted empty by a test |
| Game designer | ASK was tested before SIMULATE and BRANCH, so "what happens when it rains" and "what if…" — the literal example phrases — became questions | Scenario phrasing is detected first, and a scenario now also requires something to vary |
| Game designer / Artist | "make this 9999999 m taller" applied the number to width, certified as VALID with a footprint the size of a country, and **crashed the tab** inside the spatial index | Dimensions are capped relative to the size of the place and the cap is stated, not silent; the index holds oversize entities aside instead of allocating billions of cells; `3 m taller` is now a change of three metres, not a height of three |

## Pass 9 — the interface owed the lowest scores

Novice 6, interaction designer 6, facilitator 5, artist 4. §31: the lowest score
owns the roadmap.

- **"here" was being invented.** The app passed the camera target as the
  participant's GPS position, so "put a bench here" with nothing tapped resolved
  to wherever the view happened to point — and put a bench inside a bedroom,
  invisible, with two collision findings and a commit button that still said
  "Put it in the world". Now: no real position, no guess. It asks.
- **The certificate was decorative at the moment it mattered.** Committing an
  invalid proposal took one tap and looked identical to committing a valid one.
  §11 permits a proposal to stay in conflict — so the button now says
  *"Put it in anyway — it conflicts"*, turns red, and requires a second
  deliberate tap. The place can be overruled, never by accident.
- **CREO's own "Why is it here?" button was broken by CREO's own grammar.** The
  phrase contains the word "here", which routed it to the locative branch, which
  checked the pointer before the selection and returned a bare point. Asking an
  object to explain itself answered that nothing had been indicated.
- **Nobody could say who they were.** Authorship is modelled on every entity and
  every transaction, but `creo.author` was never written by anything, so ten
  people taking turns all committed as "you". There is now a name chip.
- **A keyboard could not select anything.** Arrow keys orbited and zoomed;
  nothing panned, nothing picked. A keyboard-only participant could act on
  exactly one point — wherever the view opened — for the entire session. Now
  `W A S D` moves a visible crosshair and `Enter` selects what it is over,
  reusing the same picker a tap uses.
- **Two people speaking about the same spot became one illegible label.**

## Standing invariants

Re-run on every pass (`node tests/run.js`, 69 tests, currently all green):

- one canonical model; index and relations cannot drift from it
- undo restores world state exactly; save/reload reproduces it exactly
- reference resolution reports its basis, or refuses
- prompts propose, geometry decides; conflict is never silently relocated
- generation N sees generations 1…N−1, including hand edits
- imagining a future never destroys the present
- every entity can say who made it, from which words, on what evidence
- authority is not truth: contradictory claims coexist
- the original expression is never overwritten by translation
- point+say works in all nine places, not only the city

---

## Critic council — round 1

§29: the builder never grades itself. §31: do not average — the lowest score is
the product score, and it owns the next pass.

| Critic | Score | The thing that broke the illusion |
|---|---|---|
| Computer scientist | 7 | Id collision after load silently destroyed an entity |
| Architect | 7 | Widening a rotated building sheared it, and certified as valid |
| Simulation engineer | 7 | Before/after water runs could be measured on different grids |
| GIS / spatial computing | 6 | A garden with a house's footprint certified as VALID |
| Urban planner | 6 | A failed placement appeared in the comparison as "changes nothing" |
| Novice / child | 6 | "put a bench here" with nothing tapped put a bench inside a bedroom |
| Interaction designer | 6 | The commit button never gated on the certificate |
| Accessibility researcher | 6 | No keyboard path to select anything, ever |
| Game designer | 6 | The two headline features were unreachable by ordinary phrasing |
| Community facilitator | 5 | No way to say who you are, so everyone is "you" |
| **Artist** | **4** | Pushed to absurdity, the system crashed instead of rendering the monster |

**Product score: 4.** Every defect above is fixed and covered by a test, but a
score is a judgement of the system as it stood, and only the council may lift it.
Round 2 has not run.

### What the artist asked for, and what was done

The artist's 4 was not really about the crash. It was that CREO has one material
register — "there is no way to make something look bad, look alien, or look like
a mistake on purpose — only geometrically absurd" — and that the single most
extreme gesture available produced a stack trace instead of an image.

The crash is fixed: absurd dimensions are capped against the size of the place,
the cap is stated rather than silent, and the index holds oversize geometry aside
instead of dying. What is **not** done is the real request — expressive range.
Nothing yet lets a person make the world ugly, wrong, or strange deliberately,
and preserve the accident as its own timeline. Branches can hold contradictory
futures; they cannot yet hold contradictory *aesthetics*.

That is the next pass, and it belongs to the artist.

---

## Pass 10 — the audit, and real ground

**Deepest failure.** Asked whether a city planner could trust it, the honest
answer was that the question had no answer: every place was a procedural fiction
anchored to a real latitude it had no relationship to. The engine's collision
reasoning had never seen a building it did not invent.

**Invariant.** *After this pass it must be impossible to claim CREO respects
buildings and roads without a measurement on buildings and roads that exist.*

**The audit.** `creo/tests/audit-geometry.mjs` — 1080 proposals across the nine
synthetic places, with ground truth re-derived directly from polygons rather
than from the certificate. Results: placement exact (0.0000 m median and max);
138 of 138 real building collisions correctly reported; **0 false negatives**;
44 conservative flags below the audit's own threshold.

It also found a real defect. Route conflicts had 71 false negatives, and the
cause was structural: a vertical interval is one scalar pair per entity, but a
graded trench's bed falls along its length. A 100 m drain running down to an
outfall at z = 1.20 was compared against a lane sitting on higher ground at
z = 5.11, so the clearance test concluded the trench passed underneath it and
said nothing. Height is now interpolated at the point the footprints actually
meet, and an open trench is treated as reaching the surface. 71 → 53, and every
remaining one is a footpath meeting a footpath, which is a junction by design.

**Real ground.** `node import.js --preset=babadogo` reads OpenStreetMap via
Overpass and elevation from opentopodata — both free, both keyless. Baba Dogo,
Nairobi: 392 building footprints, 87 roads, 8 walls, the Nairobi River, and
66 m of relief from ASTER. Every entity keeps its OSM id, its tags and its fetch
date; heights record whether they came from the data or were assumed.

**Measured on the real place:** 600 proposals, 0 crashes, placement exact,
0 cases of geometry sitting on a real building without the certificate naming
it. Committed as five regression tests so the claim cannot quietly rot.

**What this still does not establish.** That the water model is calibrated (it
is comparative, and says so); that OSM is complete or correct for any given
neighbourhood; that assumed building heights are safe to compute volumes from;
or that a planning process would accept the audit trail. It establishes that the
geometry reasoning is sound on ground that exists — which is the precondition
for the rest, not a substitute for it.
