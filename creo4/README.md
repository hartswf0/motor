# CREO-04 — one site

Not a general tool. Parcel 064.03, Johnson County, Tennessee — 29.34 acres on
HWY 321, the Watauga River along its back, and the Henry House to go on it.

Everything general lives in [`../creo3`](../creo3). This exists to answer one
question well: **where on this parcel does this house go, and what does the
ground charge for it.**

## What it found

The Henry House carries its site in `model/geometry.mjs`, and says so plainly:
the long axis bears N70°E "chosen to lie along the assumed contour", the cross
slope is 30%, and *"ALL SITE ELEVATIONS ARE ASSUMED PENDING SURVEY."*

CREO has the real ground. `node tools/check-assumptions.mjs`:

```
PARCEL 064.03 — 293 points at 20 m, inside the boundary

  the house assumes a 30% cross slope
  the parcel actually runs 3% to 87%, median 36%
  ground at or under 30%: 90 of 293 points (31% of the parcel)

  the house assumes its long axis at N70°E, along the contour
  on the flattest ground the contour runs about N90°E
  the assumption is 20° off — NOT along the contour there

  the flattest 22 m circle inside the boundary:
    1.5 m of fall, at 103 m elevation, on ground of 4%
    contour there runs N34°E
```

Three things follow, and none of them are design opinions:

1. **The assumed 30% is optimistic.** The median is 36% and two-thirds of the
   parcel is steeper than the house expects.
2. **N70°E is not the contour** on the gentle ground — it is out by about 20°,
   and the house's own logic says that orientation exists to lie along it.
   Orientation on a slope is an earthwork decision: CREO measured the best and
   worst quarter-turn elsewhere on this terrain at 412 m³ against 914 m³.
3. **There is genuinely flat ground here** — 1.5 m of fall across 22 m, at
   4%, near 103 m elevation. Whether it is buildable depends on the floodplain,
   which CREO cannot yet see, and low flat ground beside a river is exactly what
   Zone A tends to cover.

None of this says the design is wrong. It says the site the design assumed and
the site that exists are not the same site, which is what the geometry file
itself asked somebody to check.

## Still missing, and it matters most

**FEMA Zone A.** The flattest ground on the parcel is the river terrace. That is
either the obvious place for the house or the one place it cannot go, and until
the floodplain is in, CREO's most confident answer here is also its least safe.
