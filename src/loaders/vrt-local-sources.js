/**
 * Find a local VRT's source files inside folders the user granted.
 *
 * VRTs written by gdalbuildvrt on the machine that holds the data usually
 * reference sources by absolute path (relativeToVRT="0",
 * "/mnt/archive/…/gcov/scene_HH.tif"). A browser can't open a path, but it
 * can look a file up by name inside a folder the user picked
 * (showDirectoryPicker) or dropped — without listing the folder, which
 * matters for archive directories with 100k+ entries.
 *
 * A source path is tried against each folder as successively longer
 * suffixes of the path ("scene.tif", "gcov/scene.tif", …), preferring the
 * suffix that starts right after a segment named like the folder itself —
 * so picking the "gcov" folder, or any ancestor of it, both resolve.
 */

/** Path → clean segments; "." and ".." dropped (a picked folder has no known parent). */
export function pathSegments(path) {
  return String(path).replace(/\\/g, '/').split('/').filter(s => s && s !== '.' && s !== '..');
}

/**
 * Relative paths (as segment arrays) to try inside a folder named dirName,
 * most specific first.
 */
export function candidatePaths(segs, dirName) {
  const out = [];
  const seen = new Set();
  const add = (c) => {
    const key = c.join('/');
    if (c.length && !seen.has(key)) { seen.add(key); out.push(c); }
  };
  const i = dirName ? segs.lastIndexOf(dirName, segs.length - 2) : -1;
  if (i >= 0) add(segs.slice(i + 1));
  for (let k = 1; k <= segs.length; k++) add(segs.slice(-k));
  return out;
}

/** Folder adapter over a FileSystemDirectoryHandle (window.showDirectoryPicker). */
export function dirHandleSource(handle) {
  return {
    name: handle.name,
    kind: 'handle',
    async getFile(segs) {
      let dir = handle;
      for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s);
      const fh = await dir.getFileHandle(segs[segs.length - 1]);
      return fh.getFile();
    },
  };
}

/** Folder adapter over a FileSystemDirectoryEntry (a folder dropped on the page). */
export function dirEntrySource(entry) {
  return {
    name: entry.name,
    kind: 'entry',
    getFile(segs) {
      return new Promise((resolve, reject) => {
        entry.getFile(segs.join('/'), {}, (fileEntry) => fileEntry.file(resolve, reject), reject);
      });
    },
  };
}

/**
 * Build a loadVRT `findFile` resolver over folder adapters.
 * @param {Array<{name: string, getFile: (segs: string[]) => Promise<File>}>} folders
 * @returns {(path: string) => Promise<File|null>}
 */
export function makeFolderResolver(folders) {
  return async (path) => {
    const segs = pathSegments(path);
    if (segs.length === 0) return null;
    for (const folder of folders) {
      for (const c of candidatePaths(segs, folder.name)) {
        try {
          return await folder.getFile(c);
        } catch { /* not at this suffix — try the next */ }
      }
    }
    return null;
  };
}
