import { readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

/**
 * FILE UTILITIES
 * Portable file system traversal utilities
 */

/**
 * Recursively get all files in a directory
 * @param dir - Root directory to scan
 * @param stateDir - State directory to exclude from scanning
 * @param fileList - Accumulator array for results
 * @returns Array of file paths
 */
export function getAllFiles(dir: string, stateDir: string, fileList: string[] = []): string[] {
  // Exclude node_modules, .git, AND the configured stateDir (dynamic)
  // Also exclude any dir that looks like a stateDir variant (starts with same basename)
  const stateDirBase = stateDir ? basename(stateDir) : '';
  const excludePrefixes = ['node_modules', '.git', stateDirBase, '.helot-'];
  const files = readdirSync(dir);

  for (const file of files) {
    if (excludePrefixes.some(prefix => file === prefix || file.startsWith('.helot-'))) continue;
    const name = join(dir, file);
    if (statSync(name).isDirectory()) {
      getAllFiles(name, stateDir, fileList);
    } else {
      fileList.push(name);
    }
  }

  return fileList;
}

export default getAllFiles;
