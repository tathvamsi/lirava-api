import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  findQuotePage,
  joinChunks,
  mergeCaseFile,
  normalizePages,
  parseDate,
  parseWindowJson,
  partyKey,
  planWindows,
  validDate,
} from "../src/services/casefile/extract.js";

const notice = [
  { page: 1, text: "LEGAL NOTICE dated 14 March 2026.   Under Section 138 of the Negotiable Instruments Act, 1881. My client Mr A. Sharma, the payee, received cheque no. 004821 for Rs. 5,00,000 drawn by M/s Delta Traders." },
  { page: 2, text: "The cheque was presented on 2 March 2026 and returned unpaid on 4 March 2026 with the remark “funds insufficient”. You are called upon to pay within fifteen days of receipt." },
];

describe("case file extraction rules", () => {
  test("a quote is found word for word, across spacing and curly quotes, and gives the page", () => {
    const pages = normalizePages(notice);
    assert.equal(findQuotePage("cheque no. 004821 for Rs. 5,00,000", pages), 1);
    assert.equal(findQuotePage('returned unpaid on 4 March 2026 with the remark "funds insufficient"', pages), 2);
    assert.equal(findQuotePage("CHEQUE  NO. 004821   for rs. 5,00,000.", pages), 1);
  });

  test("an invented, altered or too-short quote is not accepted", () => {
    const pages = normalizePages(notice);
    assert.equal(findQuotePage("cheque no. 004821 for Rs. 7,00,000", pages), null);
    assert.equal(findQuotePage("Rs. 5", pages), null);
    assert.equal(findQuotePage(undefined, pages), null);
    assert.equal(findQuotePage(42, pages), null);
  });

  test("dates must be real calendar dates", () => {
    assert.equal(validDate("2026-03-14"), "2026-03-14");
    assert.equal(validDate("2026-02-30"), null);
    assert.equal(validDate("14 March 2026"), null);
    assert.equal(validDate("1066-01-01"), null);
    assert.equal(validDate(null), null);
  });

  test("dates are read the way lawyers write them and stored as ISO", () => {
    assert.equal(parseDate("14 March 2026"), "2026-03-14");
    assert.equal(parseDate("14th March, 2026"), "2026-03-14");
    assert.equal(parseDate("March 14, 2026"), "2026-03-14");
    assert.equal(parseDate("4 Sept 2025"), "2025-09-04");
    assert.equal(parseDate("14/03/2026"), "2026-03-14", "day first, as in India");
    assert.equal(parseDate("02-03-2026"), "2026-03-02");
    assert.equal(parseDate("2026-03-14"), "2026-03-14");
    assert.equal(parseDate("31 February 2026"), null);
    assert.equal(parseDate("March 2026"), null, "a month with no day is not a date");
    assert.equal(parseDate("next Tuesday"), null);
    assert.equal(parseDate(undefined), null);
  });

  test("the same party written two ways is one party", () => {
    assert.equal(partyKey("M/s Delta Traders"), partyKey("Delta Traders"));
    assert.equal(partyKey("Adv. Meera Iyer"), partyKey("Advocate Meera Iyer"));
    assert.equal(partyKey("Mr Anil Sharma"), partyKey("Anil Sharma"));
    assert.notEqual(partyKey("Anil Sharma"), partyKey("Anil Kumar"));
    const merged = mergeCaseFile([
      {
        doc: { id: "f3", name: "n.txt", pages: 1 },
        pages: normalizePages([{ page: 1, text: "Served on M/s Delta Traders through Adv. Meera Iyer by post today." }]),
        windows: [
          {
            parties: [
              { name: "M/s Delta Traders", role: "debtor", quote: "Served on M/s Delta Traders through" },
              { name: "Delta Traders", role: "debtor", quote: "Served on M/s Delta Traders through" },
              { name: "Adv. Meera Iyer", role: "advocate", quote: "through Adv. Meera Iyer by post" },
              { name: "Advocate Meera Iyer", role: "advocate", quote: "through Adv. Meera Iyer by post" },
            ],
          },
        ],
      },
    ]);
    assert.equal(merged.parties.length, 2);
  });

  test("model replies are parsed even with code fences and chatter, and rejected when there is no JSON", () => {
    assert.deepEqual(parseWindowJson('```json\n{"facts": []}\n```'), { facts: [] });
    assert.deepEqual(parseWindowJson('Here you go: {"docType":"notice"} Hope that helps'), { docType: "notice" });
    assert.equal(parseWindowJson("no json here"), null);
    assert.equal(parseWindowJson("{broken"), null);
    assert.equal(parseWindowJson("[1,2]"), null);
  });

  test("overlapping stored chunks are joined back without repeating the overlap", () => {
    const text = "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon";
    const a = text.slice(0, 60);
    const b = text.slice(40);
    assert.equal(joinChunks([a, b]), text);
    assert.equal(joinChunks(["only one chunk"]), "only one chunk");
    assert.equal(joinChunks(["first part with no shared text", "second part is separate"]), "first part with no shared text second part is separate");
  });

  test("long documents are split into windows that keep page markers and respect the cap", () => {
    const pages = Array.from({ length: 30 }, (_, i) => ({ page: i + 1, text: "word ".repeat(600) }));
    const windows = planWindows(pages, 7000, 6);
    assert.ok(windows.length <= 6);
    assert.ok(windows.every((w) => w.text.length < 7600));
    assert.match(windows[0].text, /^\[page 1\]/);
    assert.deepEqual(planWindows([{ page: 1, text: "   " }]), []);
  });

  test("merging keeps verified items with their page, drops invented ones, de-duplicates and sorts dates", () => {
    const merged = mergeCaseFile([
      {
        doc: { id: "f1", name: "Legal notice.pdf", pages: 2 },
        pages: normalizePages(notice),
        windows: [
          {
            docType: "notice",
            docDate: "2026-03-14",
            parties: [
              { name: "Mr A. Sharma", role: "payee", quote: "My client Mr A. Sharma, the payee" },
              { name: "Mr A. Sharma", role: "payee", quote: "My client Mr A. Sharma, the payee" },
              { name: "Mr Z. Invented", role: "accused", quote: "Mr Z. Invented drew the cheque" },
            ],
            events: [
              { date: "2026-03-04", what: "Cheque returned unpaid", quote: "returned unpaid on 4 March 2026" },
              { date: "2026-03-02", what: "Cheque presented", quote: "The cheque was presented on 2 March 2026" },
              { date: "2026-03-09", what: "Made-up hearing", quote: "the court heard the matter on 9 March" },
              { date: "9 March", what: "Bad date", quote: "returned unpaid on 4 March 2026" },
            ],
            facts: [{ text: "Cheque of Rs. 5,00,000 drawn by Delta Traders", quote: "cheque no. 004821 for Rs. 5,00,000 drawn by M/s Delta Traders" }],
            claims: [{ text: "Payment demanded within fifteen days", quote: "pay within fifteen days of receipt" }],
          },
        ],
      },
    ]);

    assert.equal(merged.parties.length, 1);
    assert.equal(merged.parties[0].source.page, 1);
    assert.deepEqual(merged.chronology.map((e) => e.date), ["2026-03-02", "2026-03-04"]);
    assert.equal(merged.chronology[1].source.page, 2);
    assert.equal(merged.facts.length, 1);
    assert.equal(merged.claims.length, 1);
    assert.equal(merged.documents[0].docType, "notice");
    assert.equal(merged.documents[0].docDate, "2026-03-14");
    // Dropped: the invented party, the invented hearing and the item with an unusable date.
    assert.equal(merged.stats.dropped, 3);
    assert.equal(merged.stats.kept, 5);
  });

  test("garbage from the model cannot crash the merge", () => {
    const merged = mergeCaseFile([
      {
        doc: { id: "f2", name: "x.txt", pages: 1 },
        pages: normalizePages([{ page: 1, text: "Some plain text of reasonable length here." }]),
        windows: [{ docType: 5, docDate: {}, parties: "nope", events: [null, 3, "x"], facts: [{}], claims: undefined }],
      },
    ]);
    assert.equal(merged.parties.length + merged.chronology.length + merged.facts.length + merged.claims.length, 0);
    assert.equal(merged.documents[0].docType, "other");
  });
});
