const MAX_LINES = 3000;
const CONTEXT = 2;
const MAX_OUTPUT_LINES = 200;

/**
 * A small line diff for text files in a film folder (edit JSON, scripts).
 * Longest-common-subsequence over lines, printed with two lines of context.
 */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return `(too long to diff: ${a.length} → ${b.length} lines)`;
  }
  // Trim the common head and tail so the table only covers what differs.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const width = y.length + 1;
  const table = new Uint32Array((x.length + 1) * width);
  for (let i = x.length - 1; i >= 0; i -= 1) {
    for (let j = y.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        x[i] === y[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  type Op = { kind: " " | "-" | "+"; text: string };
  const ops: Op[] = a.slice(0, head).map((text) => ({ kind: " " as const, text }));
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      ops.push({ kind: " ", text: x[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      ops.push({ kind: "-", text: x[i]! });
      i += 1;
    } else {
      ops.push({ kind: "+", text: y[j]! });
      j += 1;
    }
  }
  while (i < x.length) ops.push({ kind: "-", text: x[i++]! });
  while (j < y.length) ops.push({ kind: "+", text: y[j++]! });
  for (const text of a.slice(a.length - tail)) ops.push({ kind: " ", text });

  const keep = new Uint8Array(ops.length);
  ops.forEach((op, index) => {
    if (op.kind === " ") return;
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(ops.length - 1, index + CONTEXT); k += 1) {
      keep[k] = 1;
    }
  });
  const lines: string[] = [];
  let skipped = false;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      skipped = true;
      return;
    }
    if (skipped && lines.length) lines.push("...");
    skipped = false;
    lines.push(`${op.kind} ${op.text}`);
  });
  if (lines.length > MAX_OUTPUT_LINES) {
    return [...lines.slice(0, MAX_OUTPUT_LINES), `... (${lines.length - MAX_OUTPUT_LINES} more lines)`].join("\n");
  }
  return lines.join("\n");
}
