import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { Document, Paragraph, TextRun, HeadingLevel, AlignmentType, Packer } from "docx";

export interface LegalPleadingData {
  courtName: string;
  caseType: string;
  caseNumber?: string;
  year?: string;
  petitioner: string;
  respondent: string;
  synopsis?: string;
  listOfDates?: Array<{ date: string; event: string }>;
  grounds: string[];
  prayers: string[];
  verificationCity?: string;
  counselName?: string;
}

export async function generateCourtPdf(data: LegalPleadingData): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const timesRoman = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const timesBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

  let page = pdfDoc.addPage([595.28, 841.89]); // A4 Size in points
  const { width, height } = page.getSize();

  // Court Margins: 1.5 inch left (108pt), 1 inch top/right/bottom (72pt)
  const leftMargin = 108;
  const rightMargin = 72;
  const contentWidth = width - leftMargin - rightMargin;
  let y = height - 72;

  const drawCentered = (text: string, font = timesBold, size = 12) => {
    const textWidth = font.widthOfTextAtSize(text, size);
    page.drawText(text, {
      x: leftMargin + (contentWidth - textWidth) / 2,
      y,
      size,
      font,
      color: rgb(0, 0, 0),
    });
    y -= size + 8;
  };

  const drawParagraph = (text: string, font = timesRoman, size = 11, lineSpacing = 16) => {
    const words = text.split(" ");
    let line = "";

    for (const word of words) {
      const testLine = line + (line ? " " : "") + word;
      const testWidth = font.widthOfTextAtSize(testLine, size);

      if (testWidth > contentWidth && line) {
        if (y < 80) {
          page = pdfDoc.addPage([595.28, 841.89]);
          y = height - 72;
        }
        page.drawText(line, { x: leftMargin, y, size, font, color: rgb(0, 0, 0) });
        y -= lineSpacing;
        line = word;
      } else {
        line = testLine;
      }
    }

    if (line) {
      if (y < 80) {
        page = pdfDoc.addPage([595.28, 841.89]);
        y = height - 72;
      }
      page.drawText(line, { x: leftMargin, y, size, font, color: rgb(0, 0, 0) });
      y -= lineSpacing;
    }
    y -= 6;
  };

  // 1. Cause Title
  drawCentered(data.courtName.toUpperCase(), timesBold, 13);
  y -= 4;
  drawCentered(`${data.caseType.toUpperCase()} NO. ${data.caseNumber || "____"} OF ${data.year || new Date().getFullYear()}`, timesBold, 11);
  y -= 12;

  // 2. Parties
  page.drawText("IN THE MATTER OF:", { x: leftMargin, y, size: 11, font: timesBold });
  y -= 18;

  page.drawText(`${data.petitioner}`, { x: leftMargin, y, size: 11, font: timesBold });
  const petWidth = timesBold.widthOfTextAtSize("... PETITIONER", 11);
  page.drawText("... PETITIONER", { x: width - rightMargin - petWidth, y, size: 11, font: timesBold });
  y -= 18;

  drawCentered("VERSUS", timesBold, 10);
  y -= 8;

  page.drawText(`${data.respondent}`, { x: leftMargin, y, size: 11, font: timesBold });
  const respWidth = timesBold.widthOfTextAtSize("... RESPONDENT", 11);
  page.drawText("... RESPONDENT", { x: width - rightMargin - respWidth, y, size: 11, font: timesBold });
  y -= 24;

  // 3. Grounds
  drawCentered("GROUNDS", timesBold, 12);
  y -= 6;
  data.grounds.forEach((ground, idx) => {
    drawParagraph(`${idx + 1}. ${ground}`, timesRoman, 11);
  });

  // 4. Prayer Clause
  y -= 10;
  drawCentered("PRAYER", timesBold, 12);
  y -= 6;
  data.prayers.forEach((prayer, idx) => {
    drawParagraph(`(${String.fromCharCode(97 + idx)}) ${prayer}`, timesRoman, 11);
  });

  // 5. Verification
  y -= 16;
  drawCentered("VERIFICATION", timesBold, 11);
  drawParagraph(
    `Verified at ${data.verificationCity || "New Delhi"} on this day of ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}, that the contents of the above petition are true and correct to the best of my knowledge and belief.`,
    timesRoman,
    10
  );

  return pdfDoc.save();
}

export async function generateCourtDocx(data: LegalPleadingData): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440, // 1 inch
              bottom: 1440,
              left: 2160, // 1.5 inch court margin
              right: 1440,
            },
          },
        },
        children: [
          new Paragraph({
            text: data.courtName.toUpperCase(),
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
          }),
          new Paragraph({
            text: `${data.caseType.toUpperCase()} NO. ${data.caseNumber || "____"} OF ${data.year || new Date().getFullYear()}`,
            alignment: AlignmentType.CENTER,
          }),
          new Paragraph({ text: "" }),
          new Paragraph({
            children: [
              new TextRun({ text: "IN THE MATTER OF:", bold: true }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: data.petitioner, bold: true }),
              new TextRun({ text: "\t\t\t...PETITIONER", bold: true }),
            ],
          }),
          new Paragraph({
            text: "VERSUS",
            alignment: AlignmentType.CENTER,
          }),
          new Paragraph({
            children: [
              new TextRun({ text: data.respondent, bold: true }),
              new TextRun({ text: "\t\t\t...RESPONDENT", bold: true }),
            ],
          }),
          new Paragraph({ text: "" }),
          new Paragraph({
            text: "GROUNDS",
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.CENTER,
          }),
          ...data.grounds.map(
            (g, idx) =>
              new Paragraph({
                text: `${idx + 1}. ${g}`,
                spacing: { after: 120 },
              })
          ),
          new Paragraph({ text: "" }),
          new Paragraph({
            text: "PRAYER",
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.CENTER,
          }),
          ...data.prayers.map(
            (p, idx) =>
              new Paragraph({
                text: `(${String.fromCharCode(97 + idx)}) ${p}`,
                spacing: { after: 120 },
              })
          ),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}
