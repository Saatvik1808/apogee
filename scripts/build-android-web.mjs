/**
 * LEARNING NOTE: A separate web build for the app bundle
 *
 * The Android app ships its assets inside the APK, so every megabyte counts
 * twice: download size on the Play Store and storage on the phone. Phones never
 * load the 8k Earth maps (they use the 2k/4k tiers) and always use the 512 px
 * ground-detail textures, so the Android web build is the normal production
 * build minus those files (src/render/Assets.ts never requests them when native).
 *
 * Key concepts: build variants, asset pruning, APK size budgets
 */
import { execSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const out = 'dist-android';
execSync(`npx vite build --outDir ${out} --emptyOutDir`, { stdio: 'inherit' });

// 8k planet maps, and the full-size PBR detail set (`<name>_diff.jpg` etc. — the
// phone tier is `<name>_diff_512.jpg`)
const prune = [/_8k\.jpg$/, /^(grass|sand|concrete|rock|regolith)_(diff|nor|rough)\.jpg$/];
let removed = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (prune.some((re) => re.test(name))) {
      removed += statSync(p).size;
      rmSync(p);
    }
  }
};
walk(join(out, 'assets'));
let total = 0;
const size = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) size(p);
    else total += statSync(p).size;
  }
};
size(out);
console.log(`android web build: removed ${(removed / 1e6).toFixed(1)} MB of desktop-only textures, ${(total / 1e6).toFixed(1)} MB remain`);
