/**
 * Writes the print-ready reference card artefacts to ./out.
 *
 * Run with:  npm run card -- --serial=CL-0001
 *
 * Kept as a script rather than only an in-app page so the artwork can be produced
 * and version-controlled without a browser, and handed to a print shop directly.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  renderCalibrationWorksheetCsv,
  renderCardPrintPage,
  renderCardSvg,
} from '../src/core/card/printable';
import { CARD_HEIGHT_MM, CARD_SPEC_VERSION, CARD_WIDTH_MM, PATCHES } from '../src/core/card/spec';

function readFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match?.slice(prefix.length);
}

const serial = readFlag('serial');
const bleed = Number(readFlag('bleed') ?? 3);

const outputDirectory = resolve(process.cwd(), 'out');
mkdirSync(outputDirectory, { recursive: true });

const artefacts: Array<[string, string]> = [
  ['reference-card.svg', renderCardSvg({ serial, bleedMm: bleed })],
  ['reference-card-notrim.svg', renderCardSvg({ serial, bleedMm: 0 })],
  ['reference-card-print.html', renderCardPrintPage({ serial, bleedMm: bleed })],
  ['calibration-worksheet.csv', renderCalibrationWorksheetCsv()],
];

for (const [name, contents] of artefacts) {
  writeFileSync(resolve(outputDirectory, name), contents, 'utf8');
  console.log(`wrote out/${name} (${contents.length} bytes)`);
}

console.log('');
console.log(`card spec   : ${CARD_SPEC_VERSION}`);
console.log(`trim size   : ${CARD_WIDTH_MM} x ${CARD_HEIGHT_MM} mm`);
console.log(`bleed       : ${bleed} mm`);
console.log(`serial      : ${serial ?? 'UNSERIALISED'}`);
console.log(`patches     : ${PATCHES.length}`);
console.log('');
console.log('Open out/reference-card-print.html and print at exactly 100% scale.');
