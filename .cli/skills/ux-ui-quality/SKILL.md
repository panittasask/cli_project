---
name: ux-ui-quality
description: Design and implement context-aware UX/UI for web interfaces, including information architecture, visual hierarchy, components, responsive behavior, accessibility, and interaction states. Use for new screens or meaningful UI/UX redesigns, not isolated CSS alignment fixes.
---

# UX/UI Quality

Create interfaces that feel intentional, useful, and specific to the product. Treat visual design as the result of a clear user goal and content hierarchy, not as decoration layered onto a generic template.

## Working method

1. Inspect the target route or screen, its component tree, styles, tokens, data shape, existing navigation, and nearby design conventions before editing.
2. State the experience problem in concrete terms: who is using the screen, what they need to accomplish, what the primary action is, and what information must be visible first.
3. Establish a small design direction before implementing details. Choose type hierarchy, spacing rhythm, color roles, surface treatment, control dimensions, and responsive behavior that fit the product context. Reuse existing tokens when they are coherent; change them deliberately when they are not.
4. Implement the smallest coherent system: semantic structure, shared component states, predictable layout primitives, and realistic content. Keep behavior and visual changes within the requested scope.
5. Cover the full state model, not just the happy path: empty, loading, error, disabled, focused, hover, active, validation, long content, and permission or unavailable states when relevant.
6. Verify the rendered result at the project breakpoints and with keyboard interaction. Use the project’s existing browser, screenshot, or interaction test workflow when available.

## Anti-slop rules

- Do not reach for a default purple gradient, glassmorphism, oversized hero, dashboard cards, or excessive rounded containers without a product reason.
- Do not use emoji, placeholder glyphs, or arbitrary icon substitutions where the product has an icon system or a semantic HTML control is sufficient.
- Do not add visual noise to make a sparse screen feel “designed.” Improve hierarchy, copy, grouping, affordances, and states first.
- Do not invent product claims, metrics, navigation items, or decorative content just to fill space. Use the actual domain and existing data model.
- Do not scatter one-off margins, colors, or component variants when a shared token or owning layout rule is the correct fix.
- Do not add a dependency for a font, icon pack, animation library, or component kit unless the request and project constraints justify it.
- Preserve existing routes, data flow, and user-facing behavior unless the task explicitly changes them.

## Accessibility and interaction baseline

- Prefer native HTML semantics and controls. Use ARIA only to express a real semantic or state relationship, and follow the matching WAI-ARIA APG pattern for composite widgets.
- Maintain a logical heading and landmark structure, visible `:focus-visible` states, keyboard access, sensible tab order, and labels or accessible names for every control.
- Treat WCAG 2.2 AA as the accessibility target: check text and non-text contrast, focus visibility, reflow/zoom, target sizing, error identification, and status announcements where applicable.
- Respect `prefers-reduced-motion`; animation must communicate state or hierarchy and must not be required to understand or operate the interface.
- Check localized text, long labels, empty data, validation messages, and large text settings so layout does not depend on one sample string.

## Responsive review

Use the project’s breakpoints when they exist. Otherwise inspect at a narrow phone width around 320–375px, a tablet width around 768px, and a wide desktop width around 1280px. Confirm that:

- primary content and actions remain discoverable;
- navigation collapses or reflows intentionally;
- controls remain usable without horizontal scrolling;
- tables, cards, dialogs, and forms have an intentional overflow or stacking strategy;
- typography, spacing, and focus states remain legible at zoom.

## Verification and handoff

Compilation alone does not prove UX/UI quality. Run the finite project build/check, then exercise the changed interaction or render the affected screen at the relevant widths. Report the user problem, the design/system decision, the files changed, the states and viewports verified, and any remaining limitation. Do not claim visual or interaction success from a source read or build alone.

## References

- [WCAG 2 overview](https://www.w3.org/WAI/standards-guidelines/wcag/)
- [WAI-ARIA Authoring Practices Guide](https://www.w3.org/WAI/ARIA/apg/)
- [MDN: using media queries for accessibility](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Using_for_accessibility)
