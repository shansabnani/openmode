# Site design notes

The landing page in `site/` borrows its visual language from Refero's "Monocle" style reference:
https://styles.refero.design/style/9165ecb1-f068-4093-8783-1f3c98898b8a

Only the look is borrowed. The layout, navigation and every word on the page are openmode's own.

## What was taken

| Quality | In `site/styles.css` |
|---|---|
| Warm cream canvas, black ink | `--paper: #fdfcf3`, `--ink: #000000` |
| Hairline rules, not boxes or shadows | `--rule: #d9d9d9` between columns and rows; a black 1px rule opens each section |
| Caption grey for secondary text | `--caption: #6e6e6e` |
| One accent, used rarely | `--signal: #ffc500` means "copy the install command": the button in the header and the Copy button in the install box. Also the favicon and text selection |
| Serif headlines with tight tracking | Newsreader 500, `letter-spacing: -0.02em` to `-0.025em` |
| Small tracked uppercase sans labels | Inter 12px, `letter-spacing: 0.08em`, uppercase (`.eyebrow`) |
| Print-like column grid | 1200px page; 5/7 splits; three ruled columns for the abilities |
| Zero radius, zero shadow | no `border-radius` or `box-shadow` anywhere |

## Fonts

The reference uses Plantin and Helvetica Neue, both commercial. The site self-hosts free faces (SIL Open Font License, latin subset, in `site/fonts/`):

- **Newsreader** (variable, 400 to 700, optical sizes) for headlines and body text
- **Inter** (variable, 400 to 700) for the small uppercase labels only
- **IBM Plex Mono** (400, 500) for commands and output

## Few words

The page was cut from 777 visible words to about 400 on 14 Nov 2026. Keep it that way: one sentence under each heading, real output instead of description, and longer answers inside the closed questions at the bottom (which also feed the FAQ structured data in the page head).

## The demo

The window at the top of the page replays how the Apollo 11 trailer was made: it types the request (the prompt saved with version 1), then shows five steps, look, edit, draft, save and final, and ends on the film playing muted. The steps are radio tabs, so the demo works without JavaScript and opens on the last step; `site/replay.js` only plays it, once, when the window scrolls into view. It does not run for visitors who ask for reduced motion, and it stops as soon as someone clicks a step. Every panel has the same shape so nothing moves between steps.

## Real output only

Every command and output block on the page was produced by openmode 0.1.0 while making the Apollo 11 demo in `examples/apollo-11` from NASA footage. The contact sheet is `openmode look` on the launch film with `--frames 10 --start 4 --end 62`; the edit file shown is a shortened `apollo.json` that still passes `openmode check`. To regenerate, rerun the commands shown on the page and copy the new sheet into `site/img/`.

`design/og.html` is the source of `site/og.png` (open at 1200x630 and screenshot); it still uses the earlier test-clip sheet, `site/img/look-sheet.jpg`. `design/screenshots/` holds the first version of the page at 1440px and 390px.
