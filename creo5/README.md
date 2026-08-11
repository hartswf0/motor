# CREO-05 — what the land offers

One parcel, one house, and the question a person actually has: **where should it
go?**

`node tools/study.mjs` walks every position the Henry House fits *wholly inside*
the boundary and asks the ground four things — how far you can see, which way,
how flat it is, and what the earthwork costs.

```
PARCEL 064.03 — 143 places the house fits wholly inside the boundary

  where             elev   fall    view  looks    earth  turn
  -17, 302          112m   5.2m   3.00km  E        359m³  N30°E
  -17, 322          115m   3.6m   3.00km  E        284m³  N105°E
  103, -318          89m   0.0m   1.74km  E          0m³  N0°E

  THE VIEW is best at -17, 302 — 3.00 km of open ground, mostly E, 359 m³.
  THE GROUND is easiest at 103, -318 — 0 m³, with 1.74 km of view.
  They are 632 m apart. That distance is the decision, and it is not CREO's
  to make.
```

That last line is the design of this tool. The view and the ground disagree by
632 metres, and no amount of intelligence resolves that — it is a question about
what the house is *for*. CREO's job is to make the trade visible and exact, and
then stop.

The viewshed is a ray cast against real elevation: 48 rays, out to 3 km, from
eye height above the finished floor, counting how far each runs before the land
closes it. Nothing is guessed and no model is asked.

## What this does not know, which is most of it

**The trees.** Twenty-seven of the twenty-nine acres are Woodland 2 on the deed,
and not one tree is mapped. Standing timber is most of what a view actually is,
and most of what a view can be *made* by clearing. Every kilometre above is a
view over bare ground that is not bare.

**Zone A.** The easiest ground — 0 m³, dead flat, at 89 m — is low ground near
the Watauga. That is either the obvious place for the house or the one place it
cannot go.

**The house.** CREO draws the mass: 21.9 × 7.9 m, three levels, from
`geometry.mjs`. The rooms, the roof, the glass wall and the terrace are all in
that module and none of them are drawn. The design's own orientation was chosen
for view and sun; CREO has only measured earth and sightlines.

**And it is still a script.** This runs in node, and the results are baked into
the place. Nobody should need a terminal to ask where a house goes — that is the
next thing to build, and it matters more than anything above.
