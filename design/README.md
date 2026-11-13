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
| One accent, used rarely | `--signal: #ffc500`: the install Copy button, the two highlighted facts in the hero, the favicon, text selection |
| Serif headlines with tight tracking | Newsreader 500, `letter-spacing: -0.02em` to `-0.025em` |
| Small tracked uppercase sans labels | Inter 12px, `letter-spacing: 0.08em`, uppercase (`.eyebrow`) |
| Print-like column grid | 1200px page; 5/7 splits; three ruled columns for the abilities |
| Zero radius, zero shadow | no `border-radius` or `box-shadow` anywhere |

## Fonts

The reference uses Plantin and Helvetica Neue, both commercial. The site self-hosts free faces (SIL Open Font License, latin subset, in `site/fonts/`):

- **Newsreader** (variable, 400 to 700, optical sizes) for headlines and body text
- **Inter** (variable, 400 to 700) for the small uppercase labels only
- **IBM Plex Mono** (400, 500) for commands and output

## Real output only

Every command and output block on the page was produced by openmode 0.1.0 on a 16-second test clip built from ffmpeg's `mandelbrot`, `life` and `color` sources. Absolute paths are shortened to `…/demo/`. To regenerate, rebuild the clip, run the commands shown on the page, and copy the new sheet and strip into `site/img/`.

`design/og.html` is the source of `site/og.png` (open at 1200x630 and screenshot). `design/screenshots/` holds the page at 1440px and 390px.
