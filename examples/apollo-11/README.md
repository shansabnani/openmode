# Apollo 11, cut by an agent

A 35-second trailer made from NASA's public-domain Apollo 11 footage: the 70mm launch film, the real launch-control countdown, and the moonwalk. Claude made it with the openmode commands below and nothing else.

Watch it: https://openmode.ai/video/apollo-11.mp4

## Render it yourself

```bash
npx -y openmode render apollo.json --final            # square, 1080x1080
npx -y openmode render apollo-vertical.json --final   # vertical, 1080x1920
```

The edit files point at NASA's own links, so the first render downloads about 245 MB of footage into openmode's cache. A draft took 40 seconds on a laptop including the download; later renders take a few seconds.

## How it was made

1. `openmode look` on each film gave a contact sheet with timestamps: where the engines light, where the rocket leaves the pad, where the flag is.
2. The launch film is silent and in slow motion. The countdown comes from a second NASA film, as an audio track, and the launch clip runs at 2x so the rocket rises as the voice says "Liftoff".
3. `openmode render apollo.json --draft` and `openmode look` on the draft, twice. The first draft showed the liftoff landing a second late.
4. The vertical version swaps the flag for the ladder, because the 9:16 crop cut the flag off.
5. `openmode save` after each change kept three versions.

## Footage

All from the NASA Image and Video Library (images.nasa.gov). NASA material is generally not copyrighted; see NASA's media usage guidelines. NASA does not endorse openmode.

- `KSC_69-71212-sRGB`: Apollo 11 launch, transferred from 70mm film
- `Apollo_11_moonwalk_montage_720p`: moonwalk highlights
- `KSC-19690716-MH-NAS01-0001-…`: Apollo 11 pre-launch and launch, with the launch-control commentary
