# Codebate — Design System

## Theme decision (scene sentence)
A developer at a navy Mission Control desk, scanning a dense multi-agent session on a large
screen: calm dark chrome, orange for the user's decisive actions, and clear Claude/Codex identity
on messages — not a purple "AI tool" glow.

## Color strategy: Mission Control
Navy surfaces + one orange accent for primary user actions. Agent identity stays on the message
chrome (Claude warm terracotta, Codex cool slate).

```
--bg:         #0b0e14
--rail-bg:    #10151d
--surface:    #151b23
--surface-2:  #1a222d
--line:       #2a3442
--line-soft:  #1f2834
--text:       #e8eef6
--muted:      #9aa8b8
--faint:      #7a8796
--accent:     #e28434   /* orange — primary actions / approve */
--accent-ink: #1a0f08
--claude:     #c46a48
--codex:      #8fb3d9
--ok:         #2ea043
--warn:       #e28434
--danger:     #d14a3c
```

Never `#000`/`#fff` as page fills. No gradient text. No side-stripe accent borders. No glass.

## Typography
- System UI stack for chrome; the agent text is body prose.
- Body reading measure capped ~72ch inside the conversation column.
- Hierarchy by scale + weight (ratio ≥1.25): session title (h1) > agent name > badges/meta.
- Numerals for metadata are `font-variant-numeric: tabular-nums`.

## Layout
- Three zones when a session is open: **sessions rail** (collapsible) + **main chat** + **context
  accordion column** (toggleable from the brand bar).
- Direction-aware via `dir` on `<html>`: RTL → rail on the right; LTR → rail on the left. Use CSS
  logical properties (`inline-start/end`, `margin-inline`, `border-inline`) so it flips for free.
- **Focused session view:** conversation dominates. Agent/mode **setup** and **execute** stay in
  collapsible drawers from the header. Context cards (goal, open points, project, decisions) live
  in the side column — hidden when empty.
- Composer is compact (near single-row) with optional text-file attach chips for the next message.
- Cards only where they earn it: agent messages and context accordion panels.

## Components
- **Agent message:** avatar (colored initial) + name + role/phase badges + prose + quiet metadata.
- **Sessions rail:** group by date or project; ⋯ menu for rename/delete; Ctrl+B collapses the rail.
- **Context column:** accordion cards bound to live session data; toggle with ◫ in the brand bar.
- **Composer:** compact textarea + attach + send; Ctrl/Cmd+Enter to send.
- **Modal:** new session, rename, approve execution, onboarding — sparingly.

## Motion
- Only opacity/transform. Drawer + modal ease-out (cubic-bezier(0.16,1,0.3,1)), ~180ms. No bounce.

## i18n
- `lang`/`dir` toggle (AR/EN) flips direction and translates chrome strings via a small strings map.
  Agent output stays in whatever language the user wrote.
