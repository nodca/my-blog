# Theme Palette Refresh Design

Date: 2026-04-16

## Goal

Refresh the blog from the current white and blood-red editorial theme to a warmer palette built around:

- `#FDF0D5` as the dominant surface and background color
- `#003049` as the structural and typographic anchor
- `#D62828` as the restrained high-energy accent

The approved direction is a softened editorial treatment: keep the current layout and strong typography, but reduce the visual harshness of borders, shadows, and hover states.

## Palette Mapping

- 60% `#FDF0D5`: page background, large surfaces, soft cards
- 30% `#003049`: main text, navigation, primary actions, structural emphasis
- 10% `#D62828`: dates, hover accents, focus states, selections, highlight marks

## Implementation Scope

- Unify runtime theme names with the daisyUI custom themes so component colors actually resolve to the new palette
- Replace old blood-red custom utilities with a new accent color token
- Update global body, dark mode, search, and code-block styling to align with the new palette
- Refresh the homepage hero and navbar so the new theme is visible immediately

## Non-Goals

- No layout rewrite
- No typography system change
- No large component refactor beyond palette and surface polish

## Validation

- Check light and dark theme switching
- Verify homepage, navbar, list cards, buttons, badges, and search styling
- Run `astro check`
