import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './code-oss.mjs';

function testPdf(linesByPage, includeOutline = false) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${linesByPage.length} /Kids [${linesByPage.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const lines of linesByPage) {
    const content = lines.map((line, index) => `BT /F1 26 Tf 36 ${540 - index * 52} Td (${line}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 440 590] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  if (includeOutline) {
    const outline = objects.length + 1;
    const section = outline + 1;
    const detail = outline + 2;
    objects[0] = `<< /Type /Catalog /Pages 2 0 R /Outlines ${outline} 0 R /Dests << /Detail [6 0 R /XYZ null 590 null] >> >>`;
    objects.push(
      `<< /Type /Outlines /First ${section} 0 R /Last ${section} 0 R /Count 2 >>`,
      `<< /Title (Annual review) /Parent ${outline} 0 R /First ${detail} 0 R /Last ${detail} 0 R /Count 1 /Dest [4 0 R /XYZ null 590 null] >>`,
      `<< /Title (Ledger detail) /Parent ${section} 0 R /A << /S /GoTo /D /Detail >> >>`,
    );
  }
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

export async function makeFixtures(folder = join(root, '.smoke', 'documents')) {
  await mkdir(folder, { recursive: true });
  const files = [join(folder, 'Review A.pdf'), join(folder, 'Review B.pdf')];
  await Promise.all([
    writeFile(files[0], testPdf([['LEDGER annual review', 'Second LEDGER result'], ['Third LEDGER detail']], true)),
    writeFile(files[1], testPdf([['Reference document', 'LEDGER on the right']])),
  ]);
  return files;
}
