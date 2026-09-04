#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch').default || require('pixelmatch');
const { BASELINE_DIR, CURRENT_DIR, DIFF_DIR } = require('./support');

// A hair above zero, not exactly zero, purely to absorb residual sub-pixel
// antialiasing noise — investigate any nonzero number, don't just trust the
// exit code.
const FAIL_THRESHOLD_PCT = 0.01;

function listPngs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
}

function readPng(filePath) {
  return PNG.sync.read(fs.readFileSync(filePath));
}

function main() {
  const baselineFiles = listPngs(BASELINE_DIR);
  const currentFiles = listPngs(CURRENT_DIR);

  if (baselineFiles.length === 0) {
    console.error(`No baseline images found in ${BASELINE_DIR}. Run: npm run test:visual:baseline`);
    process.exit(1);
  }

  fs.mkdirSync(DIFF_DIR, { recursive: true });

  const baselineSet = new Set(baselineFiles);
  const currentSet = new Set(currentFiles);
  const missingInCurrent = baselineFiles.filter((f) => !currentSet.has(f));
  const extraInCurrent = currentFiles.filter((f) => !baselineSet.has(f));

  const rows = [];
  let anyFail = false;

  for (const file of baselineFiles) {
    if (!currentSet.has(file)) continue; // reported separately as missing
    const baseImg = readPng(path.join(BASELINE_DIR, file));
    const curImg = readPng(path.join(CURRENT_DIR, file));

    if (baseImg.width !== curImg.width || baseImg.height !== curImg.height) {
      rows.push({ file, pct: null, note: `size mismatch ${baseImg.width}x${baseImg.height} vs ${curImg.width}x${curImg.height}` });
      anyFail = true;
      continue;
    }

    const { width, height } = baseImg;
    const diff = new PNG({ width, height });
    const diffPixels = pixelmatch(baseImg.data, curImg.data, diff.data, width, height, { threshold: 0.1 });
    const pct = (diffPixels / (width * height)) * 100;
    if (diffPixels > 0) {
      fs.writeFileSync(path.join(DIFF_DIR, file), PNG.sync.write(diff));
    }
    rows.push({ file, pct, note: '' });
    if (pct > FAIL_THRESHOLD_PCT) anyFail = true;
  }

  if (missingInCurrent.length || extraInCurrent.length) anyFail = true;

  console.log('\nVisual regression diff report');
  console.log('=='.repeat(30));
  for (const row of rows) {
    const pctStr = row.pct === null ? 'FAIL' : `${row.pct.toFixed(4)}%`;
    console.log(`${row.pct === null || row.pct > FAIL_THRESHOLD_PCT ? 'FAIL' : 'ok  '}  ${pctStr.padStart(9)}  ${row.file}${row.note ? `  (${row.note})` : ''}`);
  }
  if (missingInCurrent.length) console.log(`\nMissing in __current__: ${missingInCurrent.join(', ')}`);
  if (extraInCurrent.length) console.log(`Extra in __current__ (no baseline): ${extraInCurrent.join(', ')}`);
  console.log('=='.repeat(30));
  console.log(anyFail ? 'RESULT: FAIL' : 'RESULT: PASS');

  process.exit(anyFail ? 1 : 0);
}

main();
