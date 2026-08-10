# CREO

**The place itself becomes conversationally operable.**

A person encounters a place, indicates something about it in ordinary human
expression, and that expression becomes a persistent, editable, testable spatial
transformation. Not a picture of one. Not a scene generated beside the real
world. A change to the world, which the world then argues with.

```bash
python3 serve.py 8800                    # then open http://localhost:8800
node tests/run.js                        # 87 tests, offline
node import.js --preset=babadogo         # import a real place from OpenStreetMap
```

Presets: `babadogo`, `kibera`, `soho`, `venice`, `amsterdam` — or any bounding box:

```bash
node import.js --bbox=52.3735,4.8790,52.3785,4.8860 --name="Jordaan" --key=jordaan
```

No API key. OpenStreetMap's Overpass API and opentopodata.org are both free and
keyless. After an import the place is a file, and everything — including the
tests — runs offline.

No dependencies. No build step. No network calls. No API keys.

---

## The compiler

```
HUMAN EXPRESSION × PLACE × SELECTION × HISTORY × OTHER PEOPLE
        ↓
   SPATIAL INTENT          ← the language layer stops here. It never sees a mesh.
        ↓
  WORLD OPERATION          ← the world engine decides what geometry can exist
        ↓
     PROPOSAL              ← a ghost, certified, not yet real
        ↓
   CONSEQUENCE             ← the same simulations, run twice, differenced
        ↓
   SHARED PLACE
```

The word does not become an image. The word becomes an operation. The operation
enters an existing place. The existing place constrains it. The place responds.
People revise it. The revision remains.

---

## Built in dependency order

| Layer | Where | What is actually true |
|---|---|---|
| Geometry | `src/core/geom.js` | Real polygon footprints with vertical intervals, in metres on a local ENU plane. Oriented bounds, ear-clipping triangulation, miter offset, polyline buffering, snapping (vertex → midpoint → edge → axis extension), true polygon intersection — bounding boxes are only broadphase. |
| PlaceModel | `src/core/place.js` | One canonical world. Entities carry geometry, semantics, network membership, provenance, epistemic state, certainty, author, evidence, branch, simulation properties. Terrain is a real heightfield with slope. |
| Transactions | `src/core/tx.js` | Every change — human, generated, imported, simulated — is one journal entry with before/after snapshots, the interpreted intent, and the **original untranslated utterance**. Undo inverts exactly. |
| Spatial index | `src/core/spatialindex.js` | Uniform grid; every broadphase candidate is re-tested against real polygons, with vertical-interval tests so a bridge over a road is not a collision. |
| Relations | `src/core/relations.js` | `inside contains above below beside touches supports supportedBy connectedTo drainsTo blocks crosses` derived from geometry after every commit; `claimedBy disputedBy preserves` authored by people and never overwritten. |
| Deixis | `src/lang/deixis.js` | `this / these / here / there / behind this / between those / along here / around that / toward the river / the far corner / the one next to it / where we were before`, resolved from selection, gesture, camera, pointer, GPS, landmarks, scene graph and utterance history — and it always reports which of those it used. |
| Intent | `src/lang/interpret.js`, `lexicon.js` | Deterministic multilingual grammar (en/sw/es/pt/fr) → `OBSERVE PROPOSE MODIFY RELATE PRESERVE REMOVE BRANCH MERGE SIMULATE ASK MEASURE`. Offline, auditable, honest about what it did not understand. `setInterpreter()` puts an LLM in front — it may only produce the same Intent. |
| Proposal | `src/world/ops.js`, `generate.js` | World query → plan → ghost → certificate → consequence → commit. Generators ask the place where something can go: terrain, structures, paths, water, access, previous proposals, available space. |
| Certificate | `src/world/certificate.js` | `COLLISION UNSUPPORTED BLOCKS_ACCESS DISCONNECTED INSUFFICIENT_CLEARANCE WATER_CONFLICT ROUTE_CONFLICT RIGHT_OF_WAY_CONFLICT AIRSPACE_CONFLICT OUTSIDE_REGION REQUIRES_REMOVAL REQUIRES_RELOCATION AMBIGUOUS_REFERENCE` — each naming the actual entity and measuring the actual overlap. |
| Simulation | `src/sim/` | A rainfall **event** routed on the heightfield with infiltration, drain capacity and graded inverts — the reported figure is the peak during the storm, because that is what "it fills with water" describes; movement graph with junctions, routing, reachability and obstruction; hard shadow projection; consequence by differencing two runs **on one shared grid**. |
| Query | `src/world/query.js` | Ask the place: why are you here, why can't this go here, who changed this, what changed, what blocks this, where can this fit, what would this remove, which areas flood, compare. Answers highlight, trace, overlay and probe — prose is the caption. |
| Export | `src/world/export.js` | GeoJSON in WGS84 about the place's anchor, carrying epistemic state, certainty, author, the original utterance and who disputes it. Round-trips to sub-millimetre. |
| Interface | `src/render/`, `src/ui/` | Custom WebGL2 renderer reading the PlaceModel directly; CPU ray picking against real top faces (so tapping a roof selects the roof); adaptive fidelity high → medium → low → symbolic; one invitation at the bottom of the screen. |

---

## Laws the code enforces

- **Prompts may propose. Geometry decides.** Nothing generated bypasses the certificate.
- **Conflict is never silently relocated.** Point at an occupied spot and CREO builds there and tells you what it hit. It does not slide the proposal twenty metres to nicer ground. (`tests/run.js` → *PRO C2 · no silent nudging*)
- **Naming a thing is not asking for one.** "all of this fills with water" is testimony; "we need a drain here" is a request. Only an asking verb becomes geometry.
- **Generation N sees generations 1…N−1, including hand edits.** "Continue this pattern" continues from where the finger left it, not from the stale generated position.
- **Imagining a future never destroys the present.** Branches are overlays; AS_IS is untouched, and later AS_IS work flows into open branches.
- **Every entity can answer "why are you here?"** — who, when, from which words, on what evidence, with what certainty, and every change since.
- **Authority is not truth.** Imported data saying a lane exists and a resident saying it has not been passable for years both remain, both visible, in contradiction.
- **The original expression is never overwritten by translation.**
- **If "here" cannot be resolved, CREO asks.** It does not guess — and it will not accept a camera angle as a substitute for knowing where someone is standing.
- **The place can be overruled, but never by accident.** Committing a proposal the certificate rejected takes a second, deliberate tap on a button that says what it is doing.

---

## What the tests cover

`node tests/run.js` — 82 tests, all green.

- **Professional** — precision (`5.25 m` means 5.25 m), snapping to existing edges, real volume collision, network connection vs. decoration, save/reload fingerprint identity, 100 mixed human/AI operations undone and redone with exact world restoration, 3 000 entities with 400 local queries under 400 ms, measurement matching geometry.
- **Magic** — roof greenhouse respecting daylight corridors from real window entities; a desire line learned and then defended against a later building; "connect these" producing a supported span; three futures coexisting; merging grafts across branches; "why can't this go here" naming the obstruction; "continue this pattern" following the hand; "who changed this" and "why are you here".
- **Deixis** — including the two that matter most: *behind this* flipping side with the camera, and *"here" with nothing indicated* refusing to guess.
- **Place** — all nine environments build, index, derive relations, and accept point+say: dense settlement, one house at room scale, city block, school, rural road, forest, coastline, empty field, and a place that does not exist.
- **Invariants** — the failure conditions from the brief, written as tests that must keep failing to break.
- **Council regressions** — the eleven defects the critic council found by running the system, each now a test: id collisions after load, undo across a branch you are standing in, a fingerprint that could not tell "City Hall" from "prank shed", a sheared rotated building, before/after water measured on different grids, a garden certified valid on top of a house, uncertified branch strategies, lexicon collisions, scenario phrasing routed to the question handler, an absurd dimension that crashed the tab, and CREO's own "why is it here?" button.

---

## Where it is honest about being early

- The water model is comparative, not absolute: steady-state ponding, no momentum, no pipe hydraulics. Its assumptions are printed in `WATER_MODEL.assumptions` and shown under every metric it produces.
- Multiplayer is single-device today. The journal is the right substrate for it — every mutation is already an ordered, authored, invertible event — but no transport exists yet.
- Speech uses the browser's recogniser where present; everything it can do, typing and drawing can also do.
- **Real places import now.** `node import.js` reads OpenStreetMap and a public DEM: 392 real building footprints, 87 real roads, and 66 m of real relief for Baba Dogo, Nairobi. Every imported entity keeps its OSM identity (`way/515200210`), its tags, and the date it was fetched, so "why are you here?" answers with a citation a surveyor can follow. Data © OpenStreetMap contributors, ODbL.
- **Heights are mostly guesses, and say so.** OSM rarely records building height. Each structure carries `heightBasis` — `"3 levels × 3.1 m"` when the data says, `"assumed from building type — no height in OSM"` when it does not. Do not use this for anything that depends on volume.
- The nine synthetic places remain, clearly labelled as invented. They exist to exercise the loop, not to represent anywhere.
- The water figures are comparative. The direction of a change is robust; its magnitude moves with grid resolution, and every metric says so underneath itself.
- Time exists as scenario (rain, night, years) but not yet as a browsable past.

---

## The gauntlet

`docs/GAUNTLET.md` records each pass: the deepest failure named, the invariant
stated before coding, what changed, and the critic council's scores with
evidence. The lowest score owns the next pass.
