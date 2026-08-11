# CREO-02

CREO-01 is at [`../creo`](../creo) and still runs. This is a copy, taken at the
point where three things were clearly next and none of them fit inside the first
one's shape:

1. **The loop.** The assistant asks the world questions and gets measurements
   back, instead of receiving one paragraph of context and being asked for a
   finished answer.
2. **Regions you can keep working on.** A drawn area that can be adjusted after
   it is made, rather than redrawn.
3. **More than one person.** Two people in the same place, seeing each other.

CREO-01 stays where it is so there is always something that works to compare
against. Nothing here is a rewrite: the substrate — geometry, the place model,
the transaction journal, the certificate, the water and movement models, the
renderer — is the same code, and improvements to it should flow both ways until
they genuinely diverge.

## What is different so far

### The loop — `src/ai/loop.js`, `src/ai/tools.js`

The assistant no longer receives a description of the world. It receives a set
of things it may **ask** the world, and the world answers with numbers it
computed rather than recalled:

| tool | answers |
| --- | --- |
| `look` | what is near a point, with sizes and heights |
| `ground` | height, slope, which way it falls, the low point nearby |
| `measure` | exact dimensions and provenance, by id |
| `relations` | what holds up what |
| `flood` | runs the rainfall model — area, depth, what gets wet |
| `blocked` | what a footprint here would stand in the way of |
| `seat` | cut and fill in m³, and which orientation moves least earth |
| `why` | the place's own account of why something is there |
| `propose` | the only tool that produces an answer for a person |

Three rules hold it together. Everything except `propose` is **read-only** — a
test asserts that running every other tool leaves the entity count and the
journal untouched. Every answer is **computed, not recalled**; where CREO cannot
compute something it says so rather than guessing, and a test removes the ground
from a place and checks that `ground` refuses instead of inventing. And every
answer carries **units**.

The loop itself is provider-agnostic: `complete` is any function from a
conversation to tool calls, so the same loop runs against a real endpoint,
against a stub, or against a replayed transcript. **The loop is the part that
can be wrong, and it can be wrong without any model at all**, so it is tested
with a scripted one — no key, no network, nothing flaky:

```
steps: ground -> flood -> propose
said : Put a drain at the low point.
because: heavy rain floods 147299 m², deepest 0.78 m
```

Those figures are read out of the tool result by the scripted model, which is
the point: the test fails if the measurements never reach it.

## What is next, in order

**Regions you can keep working on.** Drawing is trustworthy now that CREO
refuses to record points where a pixel is worth more ground than anyone can mean
to point at, so the next thing is to be able to adjust one: drag a vertex,
insert or remove one, smooth it, all re-draping live.

**More than one person.** The mechanism is settled and it is
[unsettled-atlas](https://github.com/hartswf0/unsettled-atlas)'s: exchange
**actions, not state** — an append-only log, `BroadcastChannel` between clients
on a device, MQTT over WebSocket across them, public brokers with `?broker=` to
point elsewhere, and no server of our own.

CREO already keeps that log. The transaction journal is append-only, every entry
carries who did it and when, and branches already exist for the case where two
people disagree — which the first spec called for and which most collaborative
tools cannot express at all. Sharing a place is a URL plus a topic; being in it
together is replaying each other's entries.

Presence comes last and deliberately: a cursor with a name on it, showing where
someone is looking. Presence without shared state is theatre.

## Running it

```
python3 serve.py 8777      # http://localhost:8777
node tests/run.js          # the whole suite
node tests/run.js loop     # one group
```
