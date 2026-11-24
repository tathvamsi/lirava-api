/**
 * Common legal words in Kannada, Hindi, Marathi, Tamil and Telugu, with their English equivalents.
 *
 * The statute library and the search are in English, and the embedding model does not reliably match a question written in
 * another script to an English provision (a Kannada "anticipatory bail" request found CPC injunction rules). So when a message
 * is in one of these scripts, the English equivalents of the legal words in it are added to the search and to the checks that
 * decide what the lawyer is asking for. The original text is never changed or hidden: the hints are only appended.
 *
 * These word lists were written without native-speaking lawyers and need review, like the name lists in cite-indic.ts. A word
 * that is missing only means no hint is added, so the search behaves as it did before.
 */

/** [pattern for the word in any of the five languages, English terms it stands for] */
const TERMS: Array<[RegExp, string[]]> = [
  // What is being asked for
  [/ಕರಡು|ಡ್ರಾಫ್ಟ್|मसौदा|मसुदा|ड्राफ्ट|तैयार कर|तयार कर|வரைவு|ముసాయిదా|డ్రాఫ్ట్/, ["draft"]],
  [/ಅರ್ಜಿ|ಮನವಿ|आवेदन|याचिका|अर्ज|மனு|పిటిషన్|దరఖాస్తు/, ["application", "petition"]],
  // Bail and arrest
  [/ಮುಂಗಡ ಜಾಮೀನು|अग्रिम जमानत|अटकपूर्व जामीन|முன் ஜாமீன்|ముందస్తు బెయిల్|ముందస్తు జామీను/, ["anticipatory bail", "Section 482 BNSS"]],
  [/ಜಾಮೀನು|जमानत|जामीन|ஜாமீன்|బెయిల్|జామీను/, ["bail"]],
  [/ಬಂಧನ|ಬಂಧಿ|गिरफ्तार|अटक|கைது|అరెస్టు|అరెస్ట్/, ["arrest"]],
  [/ಎಫ್‌ಐಆರ್|ಎಫ್ಐಆರ್|ಪ್ರಥಮ ವರ್ತಮಾನ|एफआईआर|एफ़आईआर|प्राथमिकी|எப்ஐஆர்|முதல் தகவல்|ఎఫ్ఐఆర్|మొదటి సమాచార/, ["FIR", "first information report"]],
  [/ದೋಷಾರೋಪಣ ಪಟ್ಟಿ|आरोप पत्र|दोषारोप|குற்றப்பத்திரிகை|అభియోగ పత్రం|చార్జిషీట్/, ["charge sheet"]],
  [/ರದ್ದುಗೊಳಿಸ|ರದ್ದು ಮಾಡ|रद्द कर|खारिज कर|ரத்து செய்|రద్దు చేయ/, ["quash"]],
  [/ಹೇಬಿಯಸ್|हैबियस|ஹேபியஸ்|హెబియస్/, ["habeas corpus", "writ"]],
  // Offences
  [/ಕೊಲೆ|हत्या|खून|கொலை|హత్య/, ["murder", "Section 103 BNS"]],
  [/ವಂಚನೆ|धोखाधड़ी|धोखाधडी|फसवणूक|மோசடி|మోసం/, ["cheating"]],
  [/ನಕಲಿ|जालसाज|बनावट|போலி|నకిలీ|ఫోర్జరీ/, ["forgery"]],
  [/ಚೆಕ್|चेक|धनादेश|காசோலை|చెక్కు|చెక్/, ["cheque", "Section 138 Negotiable Instruments Act"]],
  // Papers, courts and civil matters
  [/ನೋಟಿಸ್|ನೋಟೀಸ್|नोटिस|नोटीस|நோட்டீஸ்|அறிவிப்பு|నోటీసు/, ["notice"]],
  [/ಉಚ್ಚ ನ್ಯಾಯಾಲಯ|उच्च न्यायालय|हाईकोर्ट|உயர் நீதிமன்றம்|హైకోర్టు|ఉన్నత న్యాయస్థానం/, ["High Court"]],
  [/ಸೆಷನ್ಸ್|सत्र न्यायालय|सेशन|செசன்ஸ்|సెషన్స్/, ["Sessions Court"]],
  [/ನ್ಯಾಯಾಲಯ|न्यायालय|अदालत|நீதிமன்றம்|కోర్టు|న్యాయస్థానం/, ["court"]],
  [/ವಿಚ್ಛೇದನ|तलाक|घटस्फोट|விவாகரத்து|విడాకులు/, ["divorce"]],
  [/ಜೀವನಾಂಶ|भरण-पोषण|भरणपोषण|पोटगी|ஜீவனாம்சம்|భరణం/, ["maintenance"]],
  [/ತಡೆಯಾಜ್ಞೆ|निषेधाज्ञा|स्थगन|मनाई हुकूम|தடை உத்தரவு|నిషేధాజ్ఞ/, ["injunction", "stay"]],
  [/ಒಪ್ಪಂದ|अनुबंध|करार|ஒப்பந்தம்|ఒప్పందం/, ["agreement", "contract"]],
  [/ಸಾಕ್ಷಿ|गवाह|साक्षीदार|சாட்சி|సాక్షి/, ["witness", "evidence"]],
];

/** True when the text has letters from one of the five scripts. */
export const hasIndicScript = (text: string) => /[ऀ-ॿ஀-௿ఀ-౿ಀ-೿]/.test(text);

/** The English terms for the legal words found in a message in one of the five scripts; empty for anything else. */
export function englishHints(text: string): string[] {
  if (!hasIndicScript(text)) return [];
  const found = new Set<string>();
  for (const [pattern, english] of TERMS) if (pattern.test(text)) english.forEach((t) => found.add(t));
  return [...found];
}

/** The text with its English hints appended, or unchanged when there are none. Used for searching and for deciding what is asked. */
export function withEnglishHints(text: string): string {
  const hints = englishHints(text);
  return hints.length ? `${text} (${hints.join(", ")})` : text;
}
