import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "pipe" });
}

export function probe(path: string): {
  streams: { codec_type: string; width?: number; height?: number; duration?: string }[];
  format: { duration: string };
} {
  return JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path], {
      encoding: "utf8",
    }),
  );
}

/** A temp folder. On macOS tmpdir() sits behind a symlink, which is on purpose: paths must survive it. */
export function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `openmode-test-${name}-`));
}

export function realTempDir(name: string): string {
  return realpathSync(tempDir(name));
}

/** Small synthetic footage: a clip with a tone, a silent clip, a still, music with a gap of silence. */
export function makeMedia(dir: string) {
  mkdirSync(join(dir, "footage"), { recursive: true });
  const talk = join(dir, "footage", "talk.mp4");
  const silent = join(dir, "footage", "silent.mp4");
  const still = join(dir, "footage", "logo.png");
  const music = join(dir, "footage", "music.wav");
  const gappy = join(dir, "footage", "gappy.mp4");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=4", "-f", "lavfi", "-i", "sine=f=440:d=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", talk]);
  ffmpeg(["-f", "lavfi", "-i", "smptebars=s=360x640:r=24:d=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", silent]);
  ffmpeg(["-f", "lavfi", "-i", "color=c=teal:s=800x800", "-frames:v", "1", still]);
  ffmpeg(["-f", "lavfi", "-i", "sine=f=220:d=10", music]);
  // 1s tone, 1.5s silence, 1s tone, over a picture that is black for the middle stretch.
  ffmpeg(["-f", "lavfi", "-i", "color=c=white:s=320x180:r=24:d=3.5",
    "-f", "lavfi", "-i", "sine=f=330:d=3.5",
    "-vf", "drawbox=c=black:t=fill:enable='between(t,1,2.5)'",
    "-af", "volume=enable='between(t,1,2.5)':volume=0",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", gappy]);
  return { talk, silent, still, music, gappy };
}
