// A tiny PDF writer for the example documents (one A4 page, Helvetica, Latin-1 text). It exists so the kit can show a
// real PDF going through the upload path without a PDF library; it is not a layout engine.

function escapePdfText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Replace characters outside Latin-1 (WinAnsi) with "?" so the text always encodes. */
function latin1Safe(s: string): string {
  return Array.from(s)
    .map((c) => (c.codePointAt(0)! <= 0xff ? c : "?"))
    .join("");
}

export function makePdf(title: string, lines: readonly string[]): Uint8Array {
  const content: string[] = ["BT", "/F1 16 Tf", "50 790 Td", `(${escapePdfText(latin1Safe(title))}) Tj`, "/F1 11 Tf"];
  for (const line of lines) {
    content.push("0 -18 Td", `(${escapePdfText(latin1Safe(line))}) Tj`);
  }
  content.push("ET");
  const stream = content.join("\n");

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
  ];

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let position = chunks[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(position);
    const buf = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    chunks.push(buf);
    position += buf.length;
  });
  const xrefStart = position;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}
