---
name: staff-ux-checklist
description: Use before finalizing the design of, or shipping code for, any staff-facing screen or flow in this app (counter/POS, order logging, tasks, delivery, attendance, cash register) — the people using it have never used any business software before and workflows must stay fast and simple without losing functionality.
---

# Staff UX Checklist (Petal / BloomCart POS)

The people who will use this app day-to-day — counter staff, florists, delivery riders — are, per the shop owner, using a system like this **for the first time in their working life**. This is not a generic "keep it simple" reminder; it's a specific, load-bearing design constraint. A screen that would be perfectly normal for an experienced retail-software user can still fail here.

This checklist is for the *staff-facing* side of the app (POS/quick-sale, order logging, task queues, delivery flow, cash register, attendance clock-in). The owner/manager back-office side (reports, settings, catalog editing) can be denser — those users opted into the tool and use it less frequently under less time pressure.

## Before finalizing a staff-facing screen or flow, check each of these

1. **Could someone complete this having never seen the app before, with no one there to explain it?** If the answer requires "well, someone would show them once" — the screen needs simplifying, not the training.
2. **Is there exactly one obvious next action?** If a screen has several equally-weighted buttons, staff will freeze or guess. One primary action should visually dominate; secondary/rare actions are smaller and out of the way, not hidden entirely.
3. **Is the common case the shortest path?** Counting taps matters here, not as a vanity metric but because a customer is standing at the counter. If a task that happens 50 times a day takes 4 screens, that's the design problem to solve before anything else about that flow.
4. **Are defaults doing the work instead of the user?** Last-used channel, last-used location, common item prices, remembered customer — pre-fill everything guessable rather than asking. A blank form is a UX bug, not a neutral starting point.
5. **Is anything asked that isn't actually required to proceed?** Per the order-model design principle: nothing should block saving except the true minimum (e.g. a channel tag + at least one item). Everything else must be editable later.
6. **Do errors tell the person what to physically do next?** "Register isn't open — tap here to open it" is correct. "Error: register_id constraint violation" is not acceptable anywhere a staff member (not a developer) will see it.
7. **Are tap targets and text sized for quick, imprecise taps** — someone talking to a customer, possibly one-handed, not sitting and reading carefully? Err large.
8. **Does this role's home screen show only what that role needs today?** A florist opening to a sales dashboard, or a rider seeing shop-wide revenue, is both a UX failure (clutter they must ignore) and a data-visibility failure (see `CLAUDE.md`'s permission requirements). Check both at once.
9. **Is any functionality actually missing, or just moved?** Simplifying a flow must never mean an owner/manager loses the ability to do something they could do before — it means the *staff* path is short while the full capability still exists (for staff at a deeper level if it's genuinely needed, or for owner/manager if it's not a staff-level action at all). If in doubt, ask rather than silently dropping a feature.
10. **Would this survive being demoed once, in person, at normal counter speed, with a real customer waiting?** If a walkthrough would need pausing to explain a step, that step needs to change.

## When designing, not just reviewing

Run through PRD-style critical flows explicitly (a plain walk-in sale, logging a WhatsApp order, opening/closing the register, assigning and completing a task, marking a delivery done) and narrate the *exact* taps/screens a first-time user would go through. If narrating it out loud sounds effortful, the design is too.
