/**
 * TradePilot ATS — Build Script
 * Bundles src/ into a single file then obfuscates it
 * Run: node scripts/build.js
 * Output: dist/index.js
 */

const { execSync } = require('child_process');
const obfuscator   = require('javascript-obfuscator');
const fs           = require('fs');
const path         = require('path');

const SRC    = path.join(__dirname, '../src/index.js');
const DIST   = path.join(__dirname, '../dist');
const BUNDLE = path.join(DIST, 'bundle.js');
const OUT    = path.join(DIST, 'index.js');

if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });
console.log('✓ dist/ cleaned');

console.log('Bundling with esbuild...');
execSync(
  `npx esbuild ${SRC} --bundle --platform=node --target=node18 --outfile=${BUNDLE}` +
  ` --external:pg-native --external:bcrypt --external:dtrace-provider`,
  { stdio: 'inherit' }
);
console.log('✓ Bundle created');

console.log('Obfuscating...');
const code       = fs.readFileSync(BUNDLE, 'utf8');
const obfuscated = obfuscator.obfuscate(code, {
  compact:                        true,
  controlFlowFlattening:          true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection:              true,
  deadCodeInjectionThreshold:     0.2,
  identifierNamesGenerator:       'hexadecimal',
  renameGlobals:                  false,
  rotateStringArray:              true,
  splitStrings:                   true,
  splitStringsChunkLength:        10,
  stringArray:                    true,
  stringArrayEncoding:            ['base64'],
  stringArrayThreshold:           0.75,
  transformObjectKeys:            false,
  disableConsoleOutput:           false,
});

fs.writeFileSync(OUT, obfuscated.getObfuscatedCode());
fs.unlinkSync(BUNDLE);

const sizeKb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`\n✈  Build complete: dist/index.js (${sizeKb} KB)`);
console.log('   Ready to publish: npm publish');
