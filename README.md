# MOTOR

Two engines built against two long specifications. They share one conviction:
**the substrate is not the picture.**

| | | |
|---|---|---|
| **[creo/](creo/)** | The place itself becomes conversationally operable. | Point at a place, say something in ordinary language, and it becomes persistent, editable, testable spatial geometry that the world then argues with. |
| **[worldtext/](worldtext/)** | The book was never content. The book was the dormant state of the world. | A body of description becomes an inhabitable, executable world without ceasing to be a body of description. |

---

## Run them

**CREO** needs a web server — ES modules cannot load from `file://`, which is
what the browser means by *"'file:' URLs are treated as unique security origins"*.

```bash
cd creo && python3 serve.py 8800     # → http://127.0.0.1:8800
```

Or use the hosted copy: **https://hartswf0.github.io/motor/creo/**

**WORLDTEXT** has no viewport at all. That is the point of it.

```bash
cd worldtext && node motor.js
```

## Test them

```bash
cd creo      && node tests/run.js    # 87 tests, including 5 against real OSM data
cd worldtext && node tests/run.js    # 36 tests
```

Both suites run with no network, no API key, and no build step.

---

## What each one refuses to do

**CREO** works on any real location. Open the place menu, choose *Take me
anywhere*, and type a street or a district: Nominatim resolves the name, Overpass
supplies what is built there, and public terrarium tiles supply the ground. No
key, no server — central Rome loads in the browser in about 25 seconds with
3 062 real buildings and 87 m of relief. Measured on real OSM data:
600 proposals, 0 crashes, 0 cases of geometry sitting on a building without the
certificate naming it, and placement exact to 0.0000 m. It will not silently
move a conflicting proposal to nicer ground. Point at
an occupied spot and it builds there and names what it hit. It will not let
generated geometry ignore geometry you moved by hand. It will not resolve "here"
by guessing when nothing was indicated — it asks. It will not let you commit a
proposal the certificate rejected without a second, deliberate tap.

**WORLDTEXT** will not let a model's invention become source truth. It will not
let a character state a fact they have no path to know. It will not synthesise
one confident answer out of three incompatible accounts. It will not wake ten
thousand people because ten thousand people exist.

---

## Where the API fits

Neither engine requires one. CREO has no model at all. WORLDTEXT has a seam —
`src/model.js` — where a model is an *escalation*, used for the two jobs rules
genuinely cannot do: parsing arbitrary prose, and speaking in a character's own
register. Provider-agnostic:

```bash
export OPENAI_API_KEY=...            # OpenAI, or anything OpenAI-compatible
export OPENAI_MODEL=...              # exact model id
export OPENAI_BASE_URL=...           # OpenRouter, vLLM, LM Studio
export ANTHROPIC_API_KEY=...         # Anthropic Messages API
export OLLAMA_HOST=http://localhost:11434   # local, no key
```

Anything the model produces enters as `GENERATED`, never `SOURCE`, naming the
model and the passage it read — and has to pass a continuity check first. A
model that invents a person while "parsing", contradicts the corpus, invents a
date, or leaks a withheld secret while phrasing is refused. Each of those is a
test.

---

## The record of how they were built

Both were built against gauntlets that demand the builder never grade itself.

- `creo/docs/GAUNTLET.md` — nine passes, each named by a failure found by
  running the thing, plus an eleven-critic council that scored the build 4/10
  and owns the next pass.
- `worldtext/docs/THEORY.md` — the laws, the invariants, and the correction
  WORLDTEXT makes to CREO's metaphysics.
