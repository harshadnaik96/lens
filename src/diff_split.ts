/**
 * Rewrites a unified diff body so every hunk line is prefixed with its
 * actual file line number, e.g. "L131+   } catch (_) {".
 * + lines get the new-file number; - lines get the old-file number;
 * context lines get the new-file number.
 * Hunk headers (@@…@@) and file headers (---/+++) are kept as-is.
 */
export function annotateDiff(body: string): string {
  const out: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of body.split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      out.push(line);
      continue;
    }
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('rename ') || line.startsWith('Binary')) {
      out.push(line);
      continue;
    }
    if (line.startsWith('+')) {
      out.push(`L${newLine}+ ${line.slice(1)}`);
      newLine++;
    } else if (line.startsWith('-')) {
      out.push(`L${oldLine}- ${line.slice(1)}`);
      oldLine++;
    } else {
      out.push(`L${newLine}  ${line.slice(1)}`);
      oldLine++;
      newLine++;
    }
  }
  return out.join('\n');
}

export interface FileDiff {
  path: string;
  oldPath: string;
  added: number;
  removed: number;
  isBinary: boolean;
  isRename: boolean;
  isDelete: boolean;
  body: string;
}

export function splitDiffByFile(diff: string): FileDiff[] {
  const lines = diff.split('\n');
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  const flush = () => { if (current) files.push(current); };
  for (const line of lines) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      flush();
      current = {
        path: m[2], oldPath: m[1],
        added: 0, removed: 0,
        isBinary: false, isRename: m[1] !== m[2],
        isDelete: false, body: line + '\n',
      };
      continue;
    }
    if (!current) continue;
    current.body += line + '\n';
    if (line.startsWith('Binary files')) current.isBinary = true;
    if (line.startsWith('deleted file mode')) current.isDelete = true;
    if (line.startsWith('+') && !line.startsWith('+++')) current.added++;
    else if (line.startsWith('-') && !line.startsWith('---')) current.removed++;
  }
  flush();
  return files;
}
