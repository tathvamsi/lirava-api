import type { ParsedCite } from "./types.js";

/**
 * Reading statute citations written in Hindi, Marathi, Kannada, Tamil and Telugu (and the digits of other Indian
 * scripts). Case citations (INSC, SCR, SCC, AIR) are written with Latin letters and digits in every language, so
 * only digits need converting for those.
 *
 * Deterministic, like the rest of the parser. A name that is not on these lists is simply not recognised, so the
 * citation goes unchecked; it is never mapped to the wrong Act. A name shared by two Acts (the Hindi
 * "भारतीय साक्ष्य अधिनियम" is both the Evidence Act 1872 and the Bharatiya Sakshya Adhiniyam 2023) is accepted only
 * when the year is written beside it.
 *
 * These lists were written without a native-speaking lawyer in each language. Treat them as a first version: have
 * one review each list, and add the spellings that lawyers there actually use.
 */

// Zero of each script's digits. All are single UTF-16 units, so converting leaves every character offset unchanged.
const DIGIT_ZEROS = [0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x06f0, 0x0660];
const hex4 = (n: number) => n.toString(16).padStart(4, "0");
const DIGITS = new RegExp(`[${DIGIT_ZEROS.map((z) => `\\u${hex4(z)}-\\u${hex4(z + 9)}`).join("")}]`, "g");

/** Replaces Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam and Arabic-Indic digits with 0-9. */
export function normalizeIndic(text: string): string {
  return text.replace(DIGITS, (ch) => {
    const cp = ch.charCodeAt(0);
    const zero = DIGIT_ZEROS.find((z) => cp >= z && cp <= z + 9) as number;
    return String(cp - zero);
  });
}

/** The word for "section" in each language. */
const SECTION_WORDS = ["धारा", "कलम", "ಕಲಂ", "ಸೆಕ್ಷನ್", "பிரிவு", "செக்ஷன்", "సెక్షన్", "సెక్షను"];

interface NativeAct {
  code: string;
  /** Regex sources. Tamil, Kannada and Telugu names are given as stems, because the ending changes with the grammar. */
  patterns: string[];
}

const dots = (letters: string[]) => letters.join("\\.?\\s?") + "\\.?";

const NATIVE_ACTS: NativeAct[] = [
  {
    code: "BNSS",
    patterns: [
      "भारतीय\\s+नागरिक\\s+सुरक्षा\\s+संहिता",
      "ಭಾರತೀಯ\\s+ನಾಗರಿಕ\\s+ಸುರಕ್ಷಾ\\s+ಸಂಹಿತೆ",
      "பாரதிய\\s+நாகரிக்?\\s+சுரக்ஷா\\s+சம்ஹிதா",
      "భారతీయ\\s+నాగరిక\\s+సురక్షా\\s+సంహిత",
      dots(["भा", "ना", "सु", "सं"]),
      "बीएनएसएस",
      "ಬಿಎನ್ಎಸ್ಎಸ್",
      "பிஎன்எஸ்எஸ்",
      "బీఎన్ఎస్ఎస్",
    ],
  },
  {
    code: "BNS",
    patterns: [
      "भारतीय\\s+न्याय\\s+संहिता",
      "ಭಾರತೀಯ\\s+ನ್ಯಾಯ\\s+ಸಂಹಿತೆ",
      "பாரதிய\\s+நியாய\\s+சம்ஹிதா",
      "பாரதீய\\s+நியாய\\s+சன்ஹிதா",
      "భారతీయ\\s+న్యాయ\\s+సంహిత",
      dots(["भा", "न्या", "सं"]),
      "बीएनएस",
      "ಬಿಎನ್ಎಸ್",
      "பிஎன்எஸ்",
      "బీఎన్ఎస్",
    ],
  },
  {
    code: "BSA",
    patterns: ["भारतीय\\s+साक्ष्य\\s+अधिनियम,?\\s*2023", "ಭಾರತೀಯ\\s+ಸಾಕ್ಷ್ಯ\\s+ಅಧಿನಿಯಮ,?\\s*2023", "భారతీయ\\s+సాక్ష్య\\s+అధినియమం,?\\s*2023", "बीएसए"],
  },
  {
    code: "IEA",
    patterns: ["(?:भारतीय\\s+)?साक्ष्य\\s+अधिनियम,?\\s*1872", "ಭಾರತೀಯ\\s+ಸಾಕ್ಷ್ಯ\\s+ಅಧಿನಿಯಮ,?\\s*1872", "సాక్ష్య\\s+చట్టం,?\\s*1872", "இந்திய\\s+சாட்சிய\\s+சட்ட"],
  },
  {
    code: "IPC",
    patterns: [
      "भारतीय\\s+(?:दंड|दण्ड)\\s+संहिता",
      "भारतीय\\s+दंड\\s+विधान",
      "ಭಾರತೀಯ\\s+ದಂಡ\\s+ಸಂಹಿತೆ",
      "இந்திய\\s+தண்டனைச்?\\s+சட்ட",
      "భారతీయ\\s+శిక్షాస్మృతి",
      "భారత\\s+శిక్షాస్మృతి",
      dots(["भा", "द", "सं"]),
      dots(["भा", "दं", "सं"]),
      dots(["भा", "दं", "वि"]),
      "आईपीसी",
      "ಐಪಿಸಿ",
      "ஐபிசி",
      "ఐపీసీ",
      "ఐపిసి",
    ],
  },
  {
    code: "CRPC",
    patterns: [
      "(?:दंड|दण्ड)\\s+प्रक्रिया\\s+संहिता",
      "ದಂಡ\\s+ಪ್ರಕ್ರಿಯೆ\\s+ಸಂಹಿತೆ",
      "குற்றவியல்\\s+நடைமுறைச்?\\s+சட்ட",
      "నేర\\s+శిక్షాస్మృతి",
      "క్రిమినల్\\s+ప్రొసీజర్\\s+కోడ్",
      dots(["दं", "प्र", "सं"]),
      "सीआरपीसी",
      "ಸಿಆರ್ಪಿಸಿ",
      "சிஆர்பிசி",
      "సీఆర్పీసీ",
    ],
  },
  {
    code: "CPC",
    patterns: [
      "सिविल\\s+प्रक्रिया\\s+संहिता",
      "दीवानी\\s+प्रक्रिया\\s+संहिता",
      "உரிமையியல்\\s+நடைமுறைச்?\\s+சட்ட",
      "సివిల్\\s+ప్రొసీజర్\\s+కోడ్",
      dots(["सि", "प्र", "सं"]),
      "सीपीसी",
      "ಸಿಪಿಸಿ",
      "சிபிசி",
      "సీపీసీ",
    ],
  },
  {
    code: "NIA",
    patterns: ["परक्राम्य\\s+लिखत\\s+अधिनियम", "निगोशिएबल\\s+इन्स्ट्रुमेंट्स?\\s+(?:ऍक्ट|एक्ट|अधिनियम)", "நெகோஷியபிள்\\s+இன்ஸ்ட்ரூமென்ட்ஸ்?\\s+சட்ட"],
  },
];

// A few letters, spaces and commas may sit between the Act and the section word ("की", "ಯ", "ின்", "కింద" ...).
const GAP = "[\\p{L}\\p{M}\\s,]{0,14}?";
const SECW = `(?:${SECTION_WORDS.join("|")})`;
const SECTION = "\\d{1,3}[A-Za-z]{0,2}(?:\\(\\w{1,4}\\))*";
const JOINERS = "(?:,|and|&|/|और|आणि|ಮತ್ತು|மற்றும்|మరియు)";
const LIST = `${SECTION}(?:\\s*${JOINERS}\\s*${SECTION})*`;

function actAlternation(latinGroup: string): string {
  const native = NATIVE_ACTS.map((a) => `(?<a_${a.code}>${a.patterns.map((p) => `(?:${p})`).join("|")})`).join("|");
  return `${native}|(?<latin>${latinGroup})`;
}

/** Maps a matched Act group back to an act code. `latinCode` resolves the Latin spellings the main parser already knows. */
function codeFrom(groups: Record<string, string | undefined>, latinCode: (s: string) => string | null): string | null {
  for (const a of NATIVE_ACTS) if (groups[`a_${a.code}`]) return a.code;
  return groups.latin ? latinCode(groups.latin) : null;
}

/**
 * Statute citations whose section word or Act name is in an Indian language, in either order:
 *   "धारा 302 भारतीय दंड संहिता",  "भारतीय न्याय संहिता की धारा 103",  "ಭಾರತೀಯ ದಂಡ ಸಂಹಿತೆಯ ಕಲಂ 302",
 *   "இந்திய தண்டனைச் சட்டப் பிரிவு 302",  "సెక్షన్ 138 NI Act",  "कलम 420 IPC".
 * `text` must already have its digits converted (see normalizeIndic).
 */
export function extractIndicStatutes(text: string, latinActGroup: string, latinCode: (s: string) => string | null): ParsedCite[] {
  const out: ParsedCite[] = [];
  const acts = actAlternation(latinActGroup);
  const forms = [
    // section word, number(s), then the Act
    new RegExp(`(?<![\\p{L}\\p{M}])${SECW}\\s*(?<list>${LIST})${GAP}(?<![\\p{L}\\p{M}])(?:${acts})(?![A-Za-z])`, "giu"),
    // the Act, then the section word and number(s)
    new RegExp(`(?<![\\p{L}\\p{M}])(?:${acts})${GAP}(?<![\\p{L}\\p{M}])${SECW}\\s*(?<list>${LIST})(?!\\d)`, "giu"),
  ];
  for (const re of forms) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const code = codeFrom(m.groups ?? {}, latinCode);
      const list = m.groups?.list;
      if (!code || !list) continue;
      const span: [number, number] = [m.index, m.index + m[0].length];
      if (out.some((c) => span[0] < c.span[1] && c.span[0] < span[1])) continue;
      for (const s of list.split(new RegExp(`\\s*${JOINERS}\\s*`, "i")).filter(Boolean)) {
        out.push({ kind: "statute", act_code: code, section: s.replace(/\s+/g, "").toUpperCase(), raw: m[0], span });
      }
    }
  }
  return out;
}
