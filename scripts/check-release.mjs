import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function registryParity(localShasum, publishedShasum) {
  if (!publishedShasum) return 'unpublished';
  return localShasum === publishedShasum ? 'identical' : 'divergent';
}

function npm(args) {
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
}

export function checkRelease() {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const packed = npm(['pack', '--json', '--dry-run', '--ignore-scripts']);
  if (packed.status !== 0) throw new Error('could not build the local npm package receipt');
  const local = JSON.parse(packed.stdout)?.[0];
  if (!local?.shasum || local.name !== manifest.name || local.version !== manifest.version) {
    throw new Error('npm pack returned an invalid package receipt');
  }

  const published = npm(['view', `${manifest.name}@${manifest.version}`, 'dist.shasum', '--json']);
  let publishedShasum = null;
  if (published.status === 0) {
    publishedShasum = JSON.parse(published.stdout || 'null');
    if (typeof publishedShasum !== 'string') throw new Error('npm returned an invalid registry digest');
  } else if (!/E404|is not in this registry/i.test(published.stderr)) {
    throw new Error('could not verify the npm registry release');
  }

  const parity = registryParity(local.shasum, publishedShasum);
  if (parity === 'divergent') {
    throw new Error(`${manifest.name}@${manifest.version} is already published with different contents; bump the version before merging`);
  }
  const detail = parity === 'identical' ? 'matches the published tarball' : 'is not published yet';
  console.log(`release parity: ${manifest.name}@${manifest.version} ${detail} (${local.shasum})`);
  return parity;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    checkRelease();
  } catch (error) {
    console.error(`release parity failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}
