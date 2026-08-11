# CREO-03 — the theory before the program

This directory contains no code. That is deliberate. Naur's claim is that the
program is not the text; the program is the theory held by the people who built
it, and the text is a lossy projection of that theory. CREO-01 and CREO-02 have
working text and a theory that lives only in my head and in commit messages.
Everything below is an attempt to write the theory down first, so that the text
can be checked against it — and so that a person arriving later can rebuild the
text from the theory rather than archaeologise it out of the code.

The evidence for this theory is not speculative. It is the defect record of one
long working session on CREO-01.

---

## 0. What actually went wrong, classified

Twenty-odd defects. They fall into four classes, and the sizes are the finding.

### Class A — two representations of one thing, permitted to disagree (10)

| defect | the two answers | measured cost |
| --- | --- | --- |
| roads on terrain | `groundAt` bilinear vs. mesh facets | 20.8% of vertices buried; 56.3% zoomed out, worst 9.7 m |
| contours | marching squares on the quad vs. the two drawn triangles | 19.8% of contour length inside the hill, worst 4.6 m |
| drawn regions | one flat plane at the centroid vs. the ground | 15.9 m off across 31 m of fall |
| drape offset | height authored at centroid vs. read at first vertex | an 86,000 m² wood floating 60.7 m |
| window stepping | entity bounds vs. terrain extent | "one window east" moved 1012 m, not 900 |
| building on ground | 30 m DEM cell vs. 12 m house | earthwork computed, **one** sample changed |
| `S.mode` | drawing tool vs. assistant commitment | drawing and the AI silently destroyed each other |
| `S.plan` | minimap flag vs. proposal state | dismissing a proposal switched off the minimap |
| entity `_uid` | module-global vs. per-place | loading a save rewound the allocator; silent data loss |
| layer order | water at 0.02 m vs. land cover at 0.03 m | half of Boone's water painted over by the woods it runs through |

### Class B — referenced but absent, failing invisibly (6)

`captureView` deleted with its call sites left; `openAIPanel` called and never
defined; `exploreBtn` wired in JS and missing from the HTML because a
string-replace matched nothing and reported nothing; `slug` used without import;
`minimap` read off `window.CREO` where it was never exposed — four rounds of
confident wrong conclusions from that one alone.

### Class C — tests that certify the algorithm and not the artifact (2)

The contour test reimplemented marching squares and passed while a
`ReferenceError` in `buildContours` rendered every place black. Body tests
depended on a fixture deliberately absent from the repository: green locally,
red in CI.

### Class D — absence that reads as correctness (3)

A console full of expected 404s, in which a real error is invisible. `"0 things
inside"` — true, meaningless, because the circle was outside the place.
`gpt-4o` presented as the only model because a stale default was shipped.

**The distribution is the theory.** Half of everything was Class A. CREO's
recurring failure is not arithmetic and not carelessness; it is that the system
repeatedly holds **two answers to the same question** with nothing forcing them
to agree. Each individual fix was correct and none of them addressed the class.
I fixed the same disagreement — computed ground versus drawn ground — in three
different places on three different days without recognising it as one thing.

---

## 1. `<Initial Interpretation>`

**As a program theory problem.** CREO is not a 3D editor and not a chat
interface. It is an attempt to let a person make **binding statements about a
real place**, in ordinary expression, and have those statements meet a world
that can refuse them.

The real-world activity being described is **sited judgement**: standing
somewhere, noticing something, proposing a change, and finding out what the
ground, the water and the neighbours have to say about it. Architects,
hydrologists, planners and residents all do this; they do it with drawings,
levels, section cuts, site visits and argument.

The program's job is not to automate that judgement. It is to hold the
**situation** in which the judgement is made, such that a claim can be false.

The failure record above says the previous theory was under-specified in exactly
one place: it said what a place *contains*, and never said what a place **is a
single authority about**.

---

## 2. `<Theory Skeleton>`

### `{entities}`

- `<Place>` — a bounded piece of the world, at a stated resolution, with a
  stated provenance for every part of it.
- `<Ground>` — **the** surface. Not a heightfield plus a mesh plus a sampler:
  one object that is simultaneously what is drawn, what is measured, and what is
  simulated. (The central correction.)
- `<Extent>` — the region a Place covers, and separately the region its
  *contents* spill into. These are different and were conflated.
- `<Resolution>` — the finest intervention the ground can represent. A property
  of the model, not an accident of the source.
- `<Thing>` — anything occupying ground: a building, a road, a wood, a drain.
- `<Body>` — architecture at building scale: a contract (footprint, floor datum,
  height, entrances) with an appearance attached, never a mesh alone.
- `<Region>` — a piece of ground someone has indicated, which persists and can
  be re-worked.
- `<Claim>` — a statement someone makes about the place. Has an author, a time,
  an epistemic status, and may be **false**.
- `<Consequence>` — what a Claim does to the world if accepted: geometry,
  earthwork, water, access.
- `<Certificate>` — the world's verdict on a Claim.
- `<Action>` — an entry in the append-only log. The unit of undo, of history, and
  of collaboration. Not "a change to state" but "a thing someone did".
- `<Witness>` — a person present in the place. Has a name, a view, and a cursor.
- `<Question>` and `<Measurement>` — what the assistant may ask, and what came
  back. A Measurement carries its Question.

### `[operations]`

`[indicate]` a region · `[claim]` something about it · `[certify]` a claim ·
`[accept]` / `[refuse]` · `[seat]` a body, which `[settles]` ground ·
`[refine]` resolution · `[ask]` the world a question · `[measure]` ·
`[simulate]` · `[branch]` · `[merge]` · `[replay]` an action log ·
`[join]` a place as a witness.

### `<states>`

Of a `<Claim>`: `INDICATED → CLAIMED → CERTIFIED{valid|invalid|disputed} →
ACCEPTED | REFUSED | SUPERSEDED`.

Of `<Ground>` at any point: `MEASURED` (a real sample) ·
`INTERPOLATED` (between samples — invention, declared) ·
`SETTLED` (deliberately reshaped by an accepted claim).
**CREO-01 and -02 have epistemic states for things and none for the ground.**
That absence is what let a refined DEM quietly present interpolation as survey.

### `<constraints>`

- Language compiles to **intent**, never directly to geometry.
- Conflict is never silently relocated.
- Branches never destroy the present.
- Authority is not truth: contradictions may coexist, attributed.
- The builder never grades itself.

### `<invariants>` — the load-bearing part

**I1. ONE GROUND.** For any (x, y) there is exactly one height, obtained through
exactly one function, used by rendering, measurement, simulation and drawing
alike. *Any second means of obtaining it is a defect, whether or not it currently
agrees.* Class A, in one sentence.

**I2. RESOLUTION IS DECLARED AND SUFFICIENT.** A Place states the finest thing it
can represent. An operation finer than that must refine the ground or refuse.
Never compute an intervention the model cannot record.

**I3. INVENTION IS LABELLED.** Every value is `MEASURED`, `INTERPOLATED` or
`SETTLED`, and can say which. No interpolated value is ever reported as survey.

**I4. NOTHING REFERENCED IS ABSENT.** Every symbol, element id and asset the
program names exists, checked structurally, at build or boot — not at first use
by a person. Class B, in one sentence.

**I5. EVERY ASSERTION CARRIES ITS QUESTION.** Any number shown to a person can
name the operation that produced it. An assistant's sentence cites the
Measurements it was given.

**I6. ONLY ACCEPTANCE CHANGES THE WORLD.** Every other operation is read-only,
enforced by test, not by convention.

**I7. THE LOG IS THE TRUTH.** State is a fold over `<Action>`s. Undo, history,
branching and collaboration are one mechanism, not four.

**I8. TESTS TOUCH THE ARTIFACT.** A test that reimplements the logic under test
does not test it. Tests call the real function or assert on the real output.
Class C, in one sentence.

---

## 3. `<Assumption Ledger>`

| assumption | status |
| --- | --- |
| Public elevation and OSM remain free and CORS-permitted | `<safe>` — held all session, no key needed |
| One authoritative ground can serve rendering *and* simulation without unacceptable cost | `<safe>` — measured: 1,682 → 15,138 triangles, negligible |
| A building can be reduced to footprint + datum + height + entrances without losing what matters | `<uncertain>` — true for siting and earthwork; false for daylight, structure, circulation |
| Interpolating a 30 m DEM to 3 m is legitimate if declared | `<uncertain>` — legitimate for *proposing*, not for *deciding*. A real project needs survey |
| Exchanging actions gives convergence without a server | `<uncertain>` — true for disjoint edits; two people reshaping the same ground need a rule |
| A model with real tools will look before it speaks | `<requires-user-decision>` — the loop *permits* it; nothing yet *compels* it |
| Places are small (≲2 km) and single-author | `<requires-user-decision>` — all of CREO's data structures assume this |
| The person is the authority; CREO never decides | `<safe>` — and should stay a constraint, not become an assumption |

---

## 4. `<Operational Description>`

```
<Person> [indicates] <Region>
    <Region> [is-drawn-on] <Ground>              # not near it — on it (I1)
    <ground-scale-at-cursor> [enables-or-blocks] [indicate]
        # a pixel worth 4 m of ground blocks it, with a reason

<Person> [claims] <sentence> about <Region>
    <sentence> [transforms into] <Intent>         # never into geometry
    <Intent> + <Region> [transforms into] <Consequence>

<Consequence> [is-measured-by] {Ground, Water, Access, Earthwork}
    <Ground.resolution> [enables-or-blocks] <Consequence>   # I2
        # 12 m house on 30 m ground -> [refine] or refuse

<Consequence> [transforms into] <Certificate>
<Certificate> [enables-or-blocks] [accept]

<Person> [accepts] <Claim>
    [accept] [appends] <Action> to <Log>          # I7 — the only writer
    <Log> [folds into] <Place>
    <Ground> [settles]                            # earthwork is a ground edit
    every reader of <Ground> [answers to] the new shape, untold   # I1's payoff

<Assistant> [asks] <Question>
    <World> [answers with] <Measurement>          # computed, never recalled
    <Measurement> [carries] <Question>            # I5
    <Assistant> [proposes] <Claim>                # never accepts

<Witness> [joins] <Place> by <topic>
    <Action> [broadcasts to] {Witnesses}
    <Witness> [replays] <Action>                  # state never transmitted
    disagreement [transforms into] <Branch>, not into a conflict
```

---

## 5. `<Failure Description>`

| failure | response |
| --- | --- |
| Two readers of the ground disagree | **Impossible by construction** — one function, one lattice. A conformance test samples every reader and requires bit-identical answers |
| An intervention finer than the ground | Refine and declare, or refuse. Never compute what cannot be recorded |
| Interpolated value used as survey | Carried label; any export marks it; refusal to certify a *decision* on interpolation |
| A referenced symbol/element is absent | Structural check fails the build. Never reaches a person |
| A tool tries to change the world | Rejected; read-only enforced by test on entity count *and* log length |
| The model asks a bad question | Answered with what was wrong, and given another turn |
| The model never decides | Stopped with its trail intact; the trail is shown |
| Two witnesses edit the same ground | Both actions kept; the second becomes a branch, attributed. Never last-write-wins |
| A relay is unreachable | The place still works alone. Collaboration is an addition, never a dependency |
| A test passes while the program is broken | Tests call the artifact; a mutation check confirms the test fails when the code is broken |

---

## 6. `<Change Test>`

**Scenario 1 — real survey data arrives.** A LiDAR point cloud at 0.5 m replaces
the DEM for one site. Under CREO-01: cascading breakage, because resolution is
implicit everywhere. Under this theory: `<Resolution>` is declared, so the Place
changes one field; every ground sample becomes `MEASURED` instead of
`INTERPOLATED`; the renderer's lattice adapts because it already derives from the
declared cell; nothing else moves. **The theory survives.**

**Scenario 2 — the place must be shared with fifty people.** Under CREO-01:
impossible; state is local and mutation is scattered. Under this theory: `<Log>`
is already the only writer, so sharing is transport and replay; scale pressure
lands on transport, not on the model. **The theory survives, but exposes an
unanswered question**: convergence when two people settle the same ground. The
theory's answer — a branch rather than a merge — is honest but may be unusable at
fifty people. *This is the first place the theory is likely to break, and it
should be attacked next.*

**Scenario 3 — the ground itself is contested.** Two authorities publish
different elevations for one hillside (the Soft Cadastre problem). Under this
theory: `<Ground>` is singular *per Place*, so contested ground forces either a
second Place or a `<Branch>`. **This is where the theory strains.** I1 was
adopted because two grounds caused ten defects — but the world genuinely does
contain contested ground, and CREO's own constitution says contradictions may
coexist. The resolution: **one ground per branch, contradiction expressed by
branching, never by two live surfaces in one view.** A future maintainer must
understand that I1 is about *simultaneity*, not about pluralism.

---

## 7. `<Implementation Plan>`

1. **`Ground`** — the singular surface. Owns samples, resolution, provenance per
   sample, the lattice, and the *only* height function. Rendering, simulation,
   drawing and measurement all take a `Ground` and call `heightAt`. No module
   may hold its own copy or its own interpolation.
2. **Conformance test** — enumerate every reader; assert bit-identical heights
   across a dense sample of the place. This is the executable form of I1, and it
   is the first thing to write.
3. **`Resolution`** — `finestRepresentable()`, `refineFor(intervention)`, and a
   refusal path.
4. **Binding check** — symbols, element ids, asset paths, at build.
5. Port `Log`-as-only-writer; then bodies, regions, loop, witnesses.

---

## 8. `<Program Text>`

Deliberately minimal, and only the invariant that half of everything violated.
See `ground.js` and `ground.test.js` beside this file: `Ground` and the
conformance harness that makes a second opinion a test failure.

Everything else waits until this holds.

---

### What building the instrument taught

The conformance harness had three defects before it worked, and all three were
instances of the classes it exists to detect. This is not irony; it is evidence
that the classes are real and that nobody is outside them.

1. **Class D, inside the detector.** It stopped scanning after nine
   disagreements and then reported "the worst" — which was the worst of the
   first nine. It caught the historical bilinear bug and described it as
   `0.000 m`. A truncated number presented as authoritative, produced by the
   instrument built to catch exactly that.

2. **A fixture that could not fail.** The test hillside was `f(x) + g(y)`.
   For a *separable* surface the bilinear twist term `h00 − h10 − h01 + h11` is
   identically zero, so bilinear and planar interpolation are **equal**, and the
   defect the test existed for was invisible in it. A test surface must be
   capable of expressing the failure, and regularity is the enemy of that.

3. **Sampling where agreement is easy.** It probed a regular grid, which can
   march in step with the lattice and systematically miss the cell centres —
   the one place where this disagreement is maximal. Conformance is now sampled
   **adversarially**: every cell centre and both triangle centroids.

And the assertion itself was a magic number — "more than 0.5 m out" — which is
not a claim about anything. The maximum possible disagreement between a bilinear
surface and the triangles over it is `|twist|/4`; the test now computes what the
fixture makes possible and requires the harness to find ≥90% of it. It finds
100%. That measures the instrument's **sensitivity** rather than its luck.

A general rule falls out, and belongs in the theory: **an invariant is only as
good as the harness's ability to fail.** Every conformance check should be
accompanied by a deliberate violation that it must catch, and by an argument
about how much of the possible violation it can see.

## 9. `<Theory-Code Mapping>`

- **I1** → the `Ground` class (a `<type>`), its private samples, its single
  `heightAt`; enforced by `conformance()` (a `<test>`), which is the theory's
  teeth rather than its statement.
- **I2** → `Ground.resolution`, `finestRepresentable()`, `refineFor()`.
- **I3** → `Ground.provenanceAt()` and the `MEASURED | INTERPOLATED | SETTLED`
  enum (`<types>`).
- **I4** → the binding check (`<configuration>`/build step).
- **I5** → `Measurement` carrying its `Question` (CREO-02 `loop.js`).
- **I6** → the read-only test over every tool (CREO-02, already passing).
- **I7** → `Log` as sole writer.
- **I8** → tests that call exported functions; mutation checks that confirm a
  broken implementation turns the test red.
- The **defect table in §0** belongs in `<comments>` at each site, because the
  cost of the disagreement is the argument for the invariant, and a maintainer
  who does not know the cost will helpfully reintroduce a second surface.

---

## 10. `<Residual Human Theory>`

What the code will not capture, and a maintainer must hold:

1. **Why one ground, when the world has many.** I1 looks like a simplification of
   a plural world. It is not: it is a rule about *one view at one moment*.
   Pluralism lives in branches. Someone who does not understand this will add a
   "display surface" for performance and reintroduce the entire Class A.

2. **What refinement means.** Interpolating to 3 m makes a building
   *representable*, not *sited*. The number is not survey. A maintainer who
   forgets this will let CREO give planning advice on invented ground — the most
   dangerous thing it could do.

3. **Why the assistant may not accept.** Not a safety feature bolted on: it is
   the constitution. "Prompts may propose. Geometry decides." Give the model
   `accept` and CREO stops being a place model and becomes a generator.

4. **Why tests are written to fail first.** Every invariant here was learned from
   a defect that *shipped green*. A test that has never been seen to fail on the
   real code is not evidence.

5. **What CREO is for.** Not drawing buildings faster. It exists so that a person
   who is not an engineer can make a claim about somewhere they know, and have
   the ground answer back — including *no*. Every feature should be judged by
   whether it makes the ground's answer more truthful, or merely louder.
