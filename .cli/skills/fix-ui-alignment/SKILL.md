---
name: fix-ui-alignment
description: Audit and correct UX/UI alignment, spacing, sizing, grid, flexbox, form, table, and responsive-layout problems in web or app interfaces. Use when screens look polished but elements, columns, controls, icons, text baselines, cards, or page edges do not line up consistently across viewport sizes.
---

# Fix UI Alignment

## Goal

Make the interface feel structurally intentional before adding decorative polish. Fix the layout system that owns an alignment problem instead of stacking one-off margins on individual children.

## Workflow

1. Read the rendered template/component, its styles, shared layout primitives, and existing design tokens.
2. Identify the owning layout context for each problem: page container, grid, flex row, stack, table, form, or positioned overlay.
3. Establish the intended alignment lines:
   - outer container edges;
   - repeated column and card edges;
   - text and icon baselines;
   - control heights and label positions;
   - vertical spacing rhythm;
   - responsive stacking order.
4. Diagnose the root cause before editing. Check parent width, `max-width`, padding, gap, grid tracks, flex alignment, intrinsic sizing, wrapping, overflow, `box-sizing`, and default element margins.
5. Implement the smallest systemic correction. Reuse existing spacing and sizing tokens. Prefer parent-level grid/flex rules over child offsets.
6. Verify the rendered result at the project’s target breakpoints and with realistic content.

## Alignment Rules

- Align related elements to shared edges or baselines; do not rely on visual guesswork.
- Use `gap` for spacing between layout children and padding for space inside a container.
- Keep repeated spacing on a small consistent scale already present in the project.
- Prefer grid when rows or columns must share tracks; prefer flexbox for one-dimensional distribution.
- Use `min-width: 0` on flex/grid children when long content causes overflow.
- Keep controls in the same group consistent in height, padding, border width, and label alignment.
- Reserve space for validation, badges, loading states, and dynamic content to avoid layout shift.
- Avoid absolute positioning for structural page alignment.
- Avoid negative margins and unexplained pixel nudges unless the inspected design system already requires them.
- Preserve document flow, keyboard order, readable zoom, and touch-target size.

## Responsive Review

Check at least a narrow mobile width, an intermediate tablet width, and a wide desktop width, using project-defined breakpoints when available. Confirm:

- no unintended horizontal scrolling or clipped content;
- container padding remains balanced;
- columns collapse in a meaningful order;
- controls wrap without separating labels from their values;
- tables use an intentional overflow or responsive strategy;
- headings, actions, cards, and empty states retain their shared alignment lines;
- long, short, localized, empty, loading, and error content do not break the layout.

## Verification

Do not claim alignment success from compilation alone.

1. Run the project’s finite build or validation command.
2. Render or exercise the affected screen using an available interaction or screenshot workflow.
3. Compare the same alignment lines across target viewport sizes.
4. Recheck focus rings, keyboard navigation, zoom, and reduced motion when transitions are involved.
5. Report the root cause, the owning layout rule changed, and the viewport/content states verified.

Add motion, microcopy, or decorative detail only after alignment and layout stability pass.
