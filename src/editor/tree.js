// What the folder tree shows, and in what order.
//
// Pure, and separated for the usual reason: the sorting and the filtering are
// the parts that can be wrong without a window, while the rest of the sidebar
// is a list of rows that expand.
//
// Every file is shown, not only Python. A build123d project is STEP exports,
// STL, images and a README as much as it is .py, and a tree that hides them is
// a tree that has to be explained. What is hidden is only what no one wants to
// look at.

/**
 * Names that are never worth a row.
 *
 * Deliberately short. Each one is machine-written, never edited by hand, and
 * present in a great many directories: __pycache__ appears beside every module
 * that has been imported, .git holds an entire repository's plumbing, and
 * .DS_Store is written by the Finder into any folder that has been looked at.
 * Nothing else is filtered - dotfiles in general stay, because a project's
 * .gitignore or .python-version is something people do open.
 */
export const HIDDEN_NAMES = new Set(["__pycache__", ".git", ".DS_Store"]);

export function isHidden(name) {
  return HIDDEN_NAMES.has(name);
}

/**
 * The separator a path is already written with.
 *
 * Children are joined with whatever the parent used, so a tree rooted at a
 * path from the Windows folder dialog stays backslashed all the way down. That
 * matters beyond appearances: a buffer is found by comparing its path exactly,
 * so one file reached two ways under two spellings would open twice.
 */
export function separatorOf(path) {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

export function joinPath(parent, name) {
  const separator = separatorOf(parent);
  return parent.endsWith(separator) ? `${parent}${name}` : `${parent}${separator}${name}`;
}

/**
 * Filter and order one directory's contents.
 *
 * Directories first, then files, each alphabetically and case-insensitively -
 * which is what every file manager and VS Code do, and what people expect
 * strongly enough that any other order reads as a bug. Ties are broken by the
 * raw name so the order is total: "README" and "readme" can coexist on a
 * case-sensitive filesystem, and a comparison that called them equal would let
 * them swap places between refreshes.
 *
 * @param {Array<{name: string, isDirectory: boolean}>} entries
 */
export function visibleEntries(entries) {
  return entries
    .filter((entry) => !isHidden(entry.name))
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }
      const folded = left.name.localeCompare(right.name, undefined, { sensitivity: "accent" });
      return folded === 0 ? left.name.localeCompare(right.name) : folded;
    });
}

/** The last segment of a path, for naming the tree's root row. */
export function baseName(path) {
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * Whether a file lies inside a folder.
 *
 * Compared on segment boundaries rather than with startsWith, which would call
 * /proj/parts a child of /proj/part - a real pair of directory names, and the
 * kind of thing that silently mis-files a tab.
 */
export function isInside(folder, path) {
  if (typeof folder !== "string" || typeof path !== "string") {
    return false;
  }
  const separator = separatorOf(folder);
  const root = folder.endsWith(separator) ? folder : `${folder}${separator}`;
  return path.startsWith(root);
}

/**
 * The folder a new file or folder should be created in.
 *
 * "Beside what you are looking at" rather than "at the root", because the root
 * is one click away and the folder six levels down is not. A folder row means
 * inside it; a file row means beside it; nothing selected means the root, which
 * is also what happens when the selection is a path that has since been
 * deleted - the caller passes null for it and the root is the honest fallback.
 */
export function targetFolder(root, selected, isDirectory) {
  if (typeof selected !== "string" || selected === "" || !isInside(root, selected)) {
    return root;
  }
  return isDirectory === true ? selected : (parentOf(selected) ?? root);
}

/** The directory holding a path, or null when there is nothing above it. */
export function parentOf(path) {
  if (typeof path !== "string") {
    return null;
  }
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut <= 0 ? null : trimmed.slice(0, cut);
}

/**
 * Why this name cannot be used, or null when it can.
 *
 * Deliberately narrow. Whether a name is legal is the filesystem's opinion and
 * it differs by platform, so what is refused here is only what this application
 * knows to be wrong: nothing typed, a name that would put the thing somewhere
 * other than where the dialog said, and a name already taken in that folder -
 * which on a case-insensitive volume would otherwise overwrite silently.
 */
export function nameProblem(name, existing = []) {
  const trimmed = String(name ?? "").trim();
  if (trimmed === "") {
    return "Enter a name.";
  }
  if (trimmed === "." || trimmed === "..") {
    return "That name means a folder, not a new one.";
  }
  if (/[/\\]/.test(trimmed)) {
    return "A name, not a path - no slashes.";
  }
  const taken = existing.some((entry) => entry.toLowerCase() === trimmed.toLowerCase());
  return taken ? `${trimmed} is already there.` : null;
}

/**
 * A name nothing in the folder is using yet.
 *
 * The row opens with this already typed, so pressing Enter twice in a row makes
 * two files rather than one failure. `untitled.py`, then `untitled(1).py` -
 * VS Code's shape, and it reads better than a bare number because the
 * parenthesis says the digit is not part of the name.
 */
export function freeName(base, extension, existing = []) {
  const taken = new Set(existing.map((entry) => entry.toLowerCase()));
  const candidate = (suffix) => `${base}${suffix}${extension}`;
  if (!taken.has(candidate("").toLowerCase())) {
    return candidate("");
  }
  for (let index = 1; index < 1000; index += 1) {
    const name = candidate(`(${index})`);
    if (!taken.has(name.toLowerCase())) {
      return name;
    }
  }
  // A thousand untitled files in one folder is not a case worth a cleverer
  // answer; the dialog refuses the duplicate and the user types something.
  return candidate("");
}
