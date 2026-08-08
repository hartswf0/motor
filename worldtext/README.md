# WORLDTEXT MOTOR

**The book was never content. The book was the dormant state of the world.**

A body of description becomes a persistent, inhabitable, executable world without
ceasing to be a body of description.

```bash
node motor.js              # the demo world, one prompt, no viewport
node tests/run.js          # 36 falsification tests
```

No dependencies. No build step. **No API key required.**

---

## About the API

You said we must use an API for it to work. Half true, and the half matters.

**What needs no model at all** — and provably does not have one here:
retrieval, indexing, entity resolution, contradiction detection, potential
discovery, activation, semantic culling, agent wake/sleep, knowledge boundaries,
branching, event history, writeback, and all five projections. `node tests/run.js`
runs with no key and no network, and *ZERO-LLM (§81)* is one of the tests.

**What a model genuinely buys you**, and where it is wired in:

| Job | Why rules cannot do it | Where |
|---|---|---|
| **Parse** arbitrary prose | This build's deterministic front end parses 38 of 44 sentences in a hand-written corpus. On a novel it would parse a minority. | `escalateParse` → `indexWithModel()` |
| **Voice** | A character's own register is not a template. | `escalateVoice` → `agent.answerVoiced()` |

Both are **escalations**, per §60, and both are fenced:

- A model reading enters as **`GENERATED`**, never `SOURCE`, carrying the model
  name and the passage it read, at confidence ≤ 0.7.
- It must pass `admitParse()`: every name it used must actually occur in the
  sentence it was given or already exist in the world. *A model that invents a
  character while "parsing" is refused* — that is a test.
- A phrasing must pass `admitVoice()`: invented proper nouns, invented dates, or
  leaked secrets throw the sentence away and the deterministic answer is used
  instead. *Also tests.*

Any provider, chosen from the environment — nothing is OpenAI-specific:

```bash
export ANTHROPIC_API_KEY=...        # Anthropic Messages API
export OPENAI_API_KEY=...           # OpenAI, or anything OpenAI-compatible
export OPENAI_BASE_URL=...          # OpenRouter, vLLM, LM Studio
export OLLAMA_HOST=http://localhost:11434   # local, no key at all
```

Then in the prompt: `escalate` re-reads what the rules missed.

---

## About grounding

There is no external referent, and there does not need to be one. Grounding is
not latitude and longitude; grounding is **provenance**. Every statement in this
world names the passage, event, model or person it came from, and can quote it
exactly. Ask `why is that true?` and you get the sentence, its document, its
section number and its speaker.

That is a stricter kind of grounding than a coordinate, because a coordinate
cannot tell you who claimed it.

---

## The substrate

```
SOURCE PASSAGES  (exact language, stable ids, never replaced)
        +
STATEMENTS       (claim · relation · memory · schedule — each with a holder,
                  an epistemic status, a time, a branch and a provenance)
        +
EVENT LEDGER     (append-only; the only thing that advances world time)
        ↓ resolve
everything else is derived
```

| Layer | File | What it is |
|---|---|---|
| Source | `src/source.js` | The corpus. Sacred: extraction is a cache over it, never a replacement. |
| Store | `src/worldtext.js` | Entities, statements, events, branches, epistemics. Nothing renders or ticks. |
| Front end | `src/parse.js` | Named rules, source → semantic IR. Reports what it failed on rather than inventing. |
| Potential | `src/potential.js` | Latent differences, indexed and left dormant. Discovery is not enactment. |
| Activation | `src/activate.js` | What matters now. LOD for mind, 0–5. Culling before computation. |
| Agent | `src/agent.js` | A process that wakes around a person and is destroyed. Knowledge boundary lives here. |
| Scene | `src/scene.js` | An ephemeral query result. Dissolve it and the world is untouched. |
| Projection | `src/project.js` | Prose · film · timeline · map · play — one event list, five views. |
| Model | `src/model.js` | The escalation seam. Optional by construction. |
| Continuity | `src/continuity.js` | The gate generated material must pass. |

---

## What the tests prove

`node tests/run.js` — 36 tests, all green, no network.

- **Zero-LLM, zero-geometry, zero-frame, zero-GUI.** The world indexes,
  activates, branches, answers and projects with no model, no coordinates, no
  render loop and no menus.
- **10 000 people, one agent.** A census of ten thousand exists semantically;
  asking one woman a question wakes exactly one agent with a 12-statement
  context, in ~1 ms, and she goes back to sleep. Activation does not scale with
  population — measured at 10, 100, 1 000 and 10 000.
- **Destroying every agent leaves the world whole.** Five awake, all killed,
  census identical.
- **The secret test.** 100 conversations with everyone except the holder; the
  secret leaks zero times, and the holder still has it.
- **Differential knowledge.** A witness and an absent man give different accounts
  of the same event, for a structural reason, and his is an honest blank.
- **The reader knows what the character does not.**
- **Contradiction survives.** Three incompatible accounts of when the mill closed
  stay three accounts; nothing synthesises a confident year.
- **Potential is not event.** Discovery fires nothing. The estrangement + shared
  ceremony is *not ripe* with one woman present and *ripe* with both — and even
  then only an explicit enactment makes it happen.
- **Projection invariance.** One event through prose, film and timeline: identical
  ids, participants, place, time, ancestry.
- **A scene changes the world it came from.** Writeback becomes memory that a
  later question can find.
- **Generated cannot counterfeit source.** Four separate tests, including a model
  that invents a person, one that contradicts the corpus, one that leaks a secret
  while phrasing, and one that invents a date.
- **Entropy.** 200 autonomous events invent no new people and no new source facts.
- **Scale.** 20 000 passages indexed in ~150 ms; one name touches 2 entities.

---

## Where it is honest about being early

- The deterministic parser is a **compiler front end, not a language
  understander.** It covers ~30 sentence patterns. On a novel, most sentences
  will remain source-only until escalated — retrievable and quotable, but not
  structured. This is the single biggest gap, and it is the gap the model seam
  exists to close.
- Causal solvers (§49–50) are not built. There is no hydrology model here; the
  seam for one is the same `MODEL` epistemic status that already exists.
- Branch merge (§66) is stubbed: branches exist and are read through, but
  semantic merge with worldline conflict detection is not written.
- Memory is a projection of events but does not yet decay, distort or get
  reinterpreted over time (§44 is half-built).
- There is no GUI. `motor.js` is the whole interface, which is the §83 test
  passing rather than a missing feature — but a reader deserves a better surface.

---

## The theory

`docs/THEORY.md` — the laws this build is accountable to, the invariants, and the
correction it makes to the previous system's metaphysics.
