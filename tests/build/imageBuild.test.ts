import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// Drift gate for the runtime image's package refresh. BuildKit keys the
// `apt-get upgrade` layer on the pinned parent digest plus the command string,
// and every workflow build restores `cache-from: type=gha`, so without a build
// arg that moves the key the upgrade is replayed from cache forever and the
// image ships the Debian package state from the day that entry was first
// written. Nothing else fails when APT_REFRESH goes missing: the build stays
// green and only the freshness quietly stops, which is why it is pinned here.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/release.yaml'];
const STAMP_REF = /^APT_REFRESH=\$\{\{\s*steps\.(\w+)\.outputs\.(\w+)\s*\}\}$/m;

type Step = { uses?: string; id?: string; run?: string; with?: Record<string, string> };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const jobsThatBuildTheImage = (file: string) =>
  Object.values((parseYaml(read(file)) as Workflow).jobs)
    .map((job) => job.steps ?? [])
    .filter((steps) => steps.some((s) => s.uses?.startsWith('docker/build-push-action')));

describe('runtime image apt refresh', () => {
  it('declares APT_REFRESH in the runtime stage and consumes it in the upgrade', () => {
    // Scoped after the last FROM: an ARG declared in the builder stage does not
    // reach the runtime stage, so the upgrade layer's key would never move.
    const dockerfile = read('Dockerfile');
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    const declared = runtime.indexOf('ARG APT_REFRESH');
    const upgrade = runtime.indexOf('apt-get upgrade');
    expect(declared).toBeGreaterThan(-1);
    expect(upgrade).toBeGreaterThan(declared);
    // Referenced inside the RUN, not merely declared above it, so the command
    // string itself differs between builds.
    expect(runtime.slice(declared, upgrade)).toMatch(/\$\{APT_REFRESH\}/);
  });

  it('passes APT_REFRESH to every workflow build of the image', () => {
    for (const file of WORKFLOWS) {
      const jobs = jobsThatBuildTheImage(file);
      expect(jobs.length).toBeGreaterThan(0);
      for (const steps of jobs) {
        for (const step of steps) {
          if (!step.uses?.startsWith('docker/build-push-action')) continue;
          expect(step.with?.file).toBe('./Dockerfile');
          expect(step.with?.['build-args'] ?? '').toMatch(STAMP_REF);
        }
      }
    }
  });

  it('computes the stamp from the build date, not a constant', () => {
    // A literal would pin the cache key to whatever was typed and reintroduce
    // the stale layer with the arg still apparently in place.
    for (const file of WORKFLOWS) {
      for (const steps of jobsThatBuildTheImage(file)) {
        const build = steps.find((s) => s.uses?.startsWith('docker/build-push-action'));
        const [, stepId, output] = STAMP_REF.exec(build?.with?.['build-args'] ?? '') ?? [];
        const stamp = steps.find((s) => s.id === stepId);
        expect(stamp?.run).toContain('date -u');
        expect(stamp?.run).toContain(`${output}=`);
      }
    }
  });

  it('scans and pushes the same apt layer on release', () => {
    // The release job builds twice: once single-arch for Trivy, once multi-arch
    // to publish. Two stamps could straddle a day boundary and publish a layer
    // the gate never scanned.
    const [steps] = jobsThatBuildTheImage('.github/workflows/release.yaml');
    const args = (steps ?? [])
      .filter((s) => s.uses?.startsWith('docker/build-push-action'))
      .map((s) => s.with?.['build-args']);
    expect(args).toHaveLength(2);
    expect(new Set(args).size).toBe(1);
  });
});
