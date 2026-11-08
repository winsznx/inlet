import { checkRepoPath } from "./paths";
import { findSecretPatterns } from "./secrets";

export const PATCH_BUDGET = { maxFiles: 5, maxChangedLines: 300 } as const;

export type GuardFailure = { code: string; message: string; path?: string };

export type ParsedFile = {
  path: string;
  oldPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  additions: number;
  deletions: number;
};

export type DiffGuardResult = {
  ok: boolean;
  failures: GuardFailure[];
  files: ParsedFile[];
  changedLines: number;
};

const SYMLINK_MODE = /^(new file mode|old mode|new mode|deleted file mode) 120000/;
const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

function stripPrefix(path: string): string {
  return path.replace(/^"|"$/g, "").replace(/^[ab]\//, "");
}

function parseDiff(diff: string): { files: ParsedFile[]; failures: GuardFailure[]; added: string[] } {
  const failures: GuardFailure[] = [];
  const files: ParsedFile[] = [];
  const added: string[] = [];
  let current: ParsedFile | null = null;
  let sawHunkForCurrent = false;

  const finish = () => {
    if (current && !sawHunkForCurrent && !current.isDeleted && !current.isNew) {
      failures.push({ code: "malformed_diff", message: "A file section has no changes.", path: current.path });
    }
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      const match = /^diff --git (\S+) (\S+)$/.exec(line);
      if (!match?.[1] || !match[2]) {
        failures.push({ code: "malformed_diff", message: "Unrecognised diff header." });
        current = null;
        continue;
      }
      current = {
        path: stripPrefix(match[2]),
        oldPath: stripPrefix(match[1]),
        isNew: false,
        isDeleted: false,
        additions: 0,
        deletions: 0,
      };
      sawHunkForCurrent = false;
      files.push(current);
      continue;
    }
    if (!current) {
      if (line.trim() !== "" && !line.startsWith("index ")) {
        failures.push({ code: "malformed_diff", message: "Content appears before the first file header." });
      }
      continue;
    }
    if (SYMLINK_MODE.test(line)) {
      failures.push({ code: "symlink_change", message: "Patches cannot create or change symlinks.", path: current.path });
    } else if (line.startsWith("new file mode")) {
      current.isNew = true;
    } else if (line.startsWith("deleted file mode")) {
      current.isDeleted = true;
    } else if (line.startsWith("rename from") || line.startsWith("copy from")) {
      failures.push({ code: "rename_not_allowed", message: "Patches cannot rename or copy files.", path: current.path });
    } else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      failures.push({ code: "binary_change", message: "Binary changes are not allowed.", path: current.path });
    } else if (HUNK.test(line)) {
      sawHunkForCurrent = true;
    } else if (sawHunkForCurrent && line.startsWith("+")) {
      current.additions += 1;
      added.push(line.slice(1));
    } else if (sawHunkForCurrent && line.startsWith("-")) {
      current.deletions += 1;
    }
  }
  finish();
  return { files, failures, added };
}

export function guardDiff(diff: string, approvedPaths: readonly string[]): DiffGuardResult {
  if (diff.trim() === "") {
    return {
      ok: false,
      failures: [{ code: "empty_diff", message: "The patch does not change anything." }],
      files: [],
      changedLines: 0,
    };
  }
  const { files, failures, added } = parseDiff(diff);

  for (const file of files) {
    const paths = new Set([file.path, file.oldPath].filter((value): value is string => Boolean(value)));
    for (const path of paths) {
      const rejection = checkRepoPath(path, approvedPaths);
      if (rejection) {
        failures.push({ code: rejection, message: `Patch touches a path that is not allowed: ${path}`, path });
      }
    }
  }

  const changedLines = files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  if (files.length > PATCH_BUDGET.maxFiles) {
    failures.push({ code: "too_many_files", message: `Patch changes ${files.length} files. The limit is ${PATCH_BUDGET.maxFiles}.` });
  }
  if (changedLines > PATCH_BUDGET.maxChangedLines) {
    failures.push({
      code: "too_many_lines",
      message: `Patch changes ${changedLines} lines. The limit is ${PATCH_BUDGET.maxChangedLines}.`,
    });
  }
  for (const name of findSecretPatterns(added.join("\n"))) {
    failures.push({ code: "secret_pattern", message: `Added lines look like a secret (${name}).` });
  }
  if (files.length === 0 && failures.length === 0) {
    failures.push({ code: "malformed_diff", message: "No file changes were found in the patch." });
  }
  return { ok: failures.length === 0, failures, files, changedLines };
}
