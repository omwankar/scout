import type { CompetitiveBrief } from "@scout/shared";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

const MARGIN = 48;
const PAGE_W = 612; // US Letter points
const PAGE_H = 792;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_Y = PAGE_H - 28;

function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return s || "scout-brief";
}

function ensureSpace(
  doc: jsPDF,
  y: number,
  needed: number,
  drawHeader: () => void
): number {
  if (y + needed <= FOOTER_Y - 12) return y;
  doc.addPage();
  drawHeader();
  return 72;
}

function wrapText(doc: jsPDF, text: string, maxWidth: number, fontSize: number): string[] {
  doc.setFontSize(fontSize);
  return doc.splitTextToSize(text || "", maxWidth) as string[];
}

function drawPageChrome(doc: jsPDF, page: number, totalHint?: string) {
  doc.setDrawColor(30, 160, 100);
  doc.setLineWidth(2);
  doc.line(MARGIN, 36, PAGE_W - MARGIN, 36);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(120, 120, 120);
  doc.text("SCOUT · Competitive Intel Brief", MARGIN, FOOTER_Y);
  doc.text(
    totalHint ? `Page ${page} · ${totalHint}` : `Page ${page}`,
    PAGE_W - MARGIN,
    FOOTER_Y,
    { align: "right" }
  );
}

function sectionLabel(doc: jsPDF, label: string, y: number): number {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(30, 160, 100);
  doc.text(label.toUpperCase(), MARGIN, y);
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, y + 4, PAGE_W - MARGIN, y + 4);
  return y + 18;
}

function bodyParagraph(doc: jsPDF, text: string, y: number, drawHeader: () => void): number {
  const lines = wrapText(doc, text, CONTENT_W, 10);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(40, 40, 40);
  for (const line of lines) {
    y = ensureSpace(doc, y, 14, drawHeader);
    doc.text(line, MARGIN, y);
    y += 13;
  }
  return y + 6;
}

function bulletList(
  doc: jsPDF,
  items: string[],
  y: number,
  drawHeader: () => void,
  label?: string
): number {
  if (!items.length) return y;
  if (label) {
    y = ensureSpace(doc, y, 16, drawHeader);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(80, 80, 80);
    doc.text(label, MARGIN, y);
    y += 12;
  }
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(40, 40, 40);
  for (const item of items) {
    const lines = wrapText(doc, `•  ${item}`, CONTENT_W - 8, 10);
    for (let i = 0; i < lines.length; i++) {
      y = ensureSpace(doc, y, 14, drawHeader);
      doc.text(lines[i], MARGIN + (i === 0 ? 0 : 10), y);
      y += 13;
    }
  }
  return y + 4;
}

/** Build and download a structured Letter PDF of the competitive brief. */
export async function downloadBriefPdf(brief: CompetitiveBrief): Promise<void> {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const generated = new Date().toLocaleString();
  let page = 1;

  const chrome = () => {
    drawPageChrome(doc, page, brief.confidence);
  };

  chrome();

  // Title block
  let y = 58;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(20, 20, 20);
  const titleLines = wrapText(doc, brief.title, CONTENT_W, 18);
  for (const line of titleLines) {
    doc.text(line, MARGIN, y);
    y += 22;
  }

  y += 4;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 100);
  doc.text(`Confidence: ${brief.confidence.toUpperCase()}  ·  Generated ${generated}`, MARGIN, y);
  y += 16;

  doc.setFont("helvetica", "italic");
  doc.setFontSize(9);
  doc.setTextColor(90, 90, 90);
  const goalLines = wrapText(doc, `Goal: ${brief.goal}`, CONTENT_W, 9);
  for (const line of goalLines) {
    y = ensureSpace(doc, y, 12, () => {
      page += 1;
      chrome();
    });
    doc.text(line, MARGIN, y);
    y += 12;
  }
  y += 10;

  // Executive summary
  y = ensureSpace(doc, y, 40, () => {
    page += 1;
    chrome();
  });
  y = sectionLabel(doc, "Executive summary", y);
  y = bodyParagraph(doc, brief.executiveSummary, y, () => {
    page += 1;
    chrome();
  });

  // Subjects
  for (const subject of brief.subjects) {
    y = ensureSpace(doc, y, 60, () => {
      page += 1;
      chrome();
    });
    y = sectionLabel(doc, subject.name, y);

    if (subject.website) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(30, 100, 180);
      doc.text(subject.website, MARGIN, y);
      y += 14;
    }

    y = bodyParagraph(doc, subject.positioning, y, () => {
      page += 1;
      chrome();
    });

    if (subject.pricing) {
      y = ensureSpace(doc, y, 28, () => {
        page += 1;
        chrome();
      });
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(80, 80, 80);
      doc.text("Pricing", MARGIN, y);
      y += 12;
      y = bodyParagraph(doc, subject.pricing, y, () => {
        page += 1;
        chrome();
      });
    }

    y = bulletList(doc, subject.strengths, y, () => {
      page += 1;
      chrome();
    }, "Strengths");
    y = bulletList(doc, subject.weaknesses, y, () => {
      page += 1;
      chrome();
    }, "Weaknesses");
    y = bulletList(doc, subject.notableFacts, y, () => {
      page += 1;
      chrome();
    }, "Notable facts");
    y += 6;
  }

  // Comparison table
  if (brief.comparisonTable.length) {
    y = ensureSpace(doc, y, 50, () => {
      page += 1;
      chrome();
    });
    y = sectionLabel(doc, "Comparison", y);

    const names = Array.from(
      new Set(brief.comparisonTable.flatMap((row) => Object.keys(row.values)))
    );
    const head = ["Dimension", ...names];
    const body = brief.comparisonTable.map((row) => [
      row.dimension,
      ...names.map((n) => row.values[n] ?? "—"),
    ]);

    autoTable(doc, {
      startY: y,
      head: [head],
      body,
      margin: { left: MARGIN, right: MARGIN, bottom: 40 },
      styles: {
        font: "helvetica",
        fontSize: 8,
        cellPadding: 5,
        textColor: [40, 40, 40],
        overflow: "linebreak",
        valign: "top",
      },
      headStyles: {
        fillColor: [24, 32, 28],
        textColor: [61, 220, 140],
        fontStyle: "bold",
      },
      alternateRowStyles: { fillColor: [246, 248, 247] },
      didDrawPage: (data) => {
        page = data.pageNumber;
        chrome();
      },
    });

    const tableDoc = doc as jsPDF & { lastAutoTable?: { finalY: number } };
    y = (tableDoc.lastAutoTable?.finalY ?? y) + 18;
    page = doc.getNumberOfPages();
  }

  // Recommendations
  if (brief.recommendations.length) {
    y = ensureSpace(doc, y, 40, () => {
      page += 1;
      chrome();
    });
    y = sectionLabel(doc, "Recommendations", y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(40, 40, 40);
    brief.recommendations.forEach((rec, i) => {
      const lines = wrapText(doc, `${i + 1}.  ${rec}`, CONTENT_W, 10);
      for (let j = 0; j < lines.length; j++) {
        y = ensureSpace(doc, y, 14, () => {
          page += 1;
          chrome();
        });
        doc.text(lines[j], MARGIN + (j === 0 ? 0 : 12), y);
        y += 13;
      }
      y += 4;
    });
    y += 6;
  }

  // Sources
  if (brief.sources.length) {
    y = ensureSpace(doc, y, 40, () => {
      page += 1;
      chrome();
    });
    y = sectionLabel(doc, "Sources", y);
    for (const source of brief.sources) {
      y = ensureSpace(doc, y, 28, () => {
        page += 1;
        chrome();
      });
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(40, 40, 40);
      const titleLines = wrapText(doc, source.title, CONTENT_W, 9);
      for (const line of titleLines) {
        doc.text(line, MARGIN, y);
        y += 11;
      }
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(30, 100, 180);
      const urlLines = wrapText(doc, source.url, CONTENT_W, 8);
      for (const line of urlLines) {
        y = ensureSpace(doc, y, 11, () => {
          page += 1;
          chrome();
        });
        doc.text(line, MARGIN, y);
        y += 10;
      }
      if (source.usedFor) {
        doc.setTextColor(110, 110, 110);
        const used = wrapText(doc, `Used for: ${source.usedFor}`, CONTENT_W, 8);
        for (const line of used) {
          y = ensureSpace(doc, y, 11, () => {
            page += 1;
            chrome();
          });
          doc.text(line, MARGIN, y);
          y += 10;
        }
      }
      y += 8;
    }
  }

  // Limitations
  if (brief.limitations.length) {
    y = ensureSpace(doc, y, 40, () => {
      page += 1;
      chrome();
    });
    y = sectionLabel(doc, "Limitations", y);
    y = bulletList(doc, brief.limitations, y, () => {
      page += 1;
      chrome();
    });
  }

  // Stamp final page numbers
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    drawPageChrome(doc, i, `${brief.confidence} · ${total} page${total === 1 ? "" : "s"}`);
  }

  doc.save(`scout-${slugify(brief.title)}.pdf`);
}
