import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** What this build is. Ported from event-scout's version.ts. */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readGitSha(): string {
  try {
    const gitDir = path.resolve(__dirname, '../../.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head;
    const ref = head.slice(4).trim();
    try {
      return fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
    } catch {
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
      const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
      return line ? line.split(' ')[0] : '';
    }
  } catch {
    return '';
  }
}

export const VERSION = readPackageVersion();
export const GIT_SHA = (process.env.GIT_SHA ?? readGitSha()).trim();
export const BUILT_AT = process.env.BUILD_TIME ?? '';

export interface VersionInfo {
  version: string;
  commit: string;
  builtAt: string;
  display: string;
}

export function versionInfo(): VersionInfo {
  const commit = GIT_SHA.slice(0, 7);
  return { version: VERSION, commit, builtAt: BUILT_AT, display: commit ? `${VERSION}+${commit}` : VERSION };
}
