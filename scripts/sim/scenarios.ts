/**
 * Hypothetical cases for testing the platform end to end.
 *
 * EVERY PERSON, COMPANY AND DOCUMENT HERE IS INVENTED. Only the places (courts, police stations) and the law are real.
 * The "right answers" come from the text of the Acts loaded in the library (statute section texts), and the authorities are
 * past Supreme Court cases looked up in the library by name at run time: no citation number is typed in this file.
 *
 * The "use" of each past case (what it is cited for) is the author's reading and should be checked by a lawyer.
 * Each question has checks, but a check is a tripwire, not a verdict: the runner saves every answer for a person to read.
 */

export interface Reference {
  /** Words of the case title to look for in the library (case-insensitive), and the year of the decision. */
  titleLike: string;
  year: number;
  /** What the case is cited for in this scenario. */
  use: string;
}

export interface Check {
  label: string;
  /** The answer must match this. */
  must?: string;
  /** The answer must NOT match this (a wrong claim to catch). */
  mustNot?: string;
}

export interface Step {
  id: string;
  ask: string;
  note: string;
  checks: Check[];
  /** Past cases the answer is expected to cite (by reference name). */
  expectRefs?: string[];
  /** True when the question gives no language and asks for a document: the assistant must ask which language first. */
  expectLanguageQuestion?: boolean;
  /** True when the question names a language: the assistant must not ask, and must write in it (Latin-script citations kept). */
  expectScript?: "kannada" | "devanagari";
}

export interface Scenario {
  id: string;
  title: string;
  caseType: string;
  matter: { title: string; client: string; court: string; nextDate: string; notes: string };
  documents: Array<{ name: string; text: string }>;
  /** What the case file should find. Used to score the case-file build: invented parties or dates are failures. */
  truth: { parties: string[]; dates: string[] };
  references: Record<string, Reference>;
  steps: Step[];
}

export const SCENARIOS: Scenario[] = [
  // ───────────────────────────────────────────────────────── 1. Murder: regular bail after long custody
  {
    id: "S1",
    title: "Naik: regular bail in a murder case after 14 months' custody",
    caseType: "criminal / bail / murder",
    matter: {
      title: "SIM-S1 Ravi Shankar Naik v. State of Karnataka (bail)",
      client: "Ravi Shankar Naik",
      court: "High Court of Karnataka, Bengaluru",
      nextDate: "2026-12-10",
      notes: "Hypothetical case for platform testing. Accused in judicial custody since 22 Aug 2025.",
    },
    documents: [
      {
        name: "SIM-S1-FIR-extract.txt",
        text: `FIRST INFORMATION REPORT (extract)
Kodigehalli Police Station, Bengaluru City. Crime No. 214/2025.
Date and time of report: 16 August 2025, 06:40 hours.
Informant: Mrs. Lakshmi Gowda, wife of the deceased, resident of Doddabommasandra, Bengaluru.
Date and place of occurrence: 15 August 2025 at about 22:15 hours, near the Sri Venkateshwara tea stall on Vidyaranyapura Main Road.

Facts reported: My husband Manjunath Gowda (aged 41) was standing at the tea stall. The accused Ravi Shankar Naik, whom we know from the neighbourhood, came with another person, accused no. 2 Shivu alias Shivakumar, after an old quarrel about a parking space. Ravi Shankar Naik struck my husband once on the head with an iron rod. My husband fell down bleeding. He was taken to M.S. Ramaiah Hospital where he was declared dead at 23:30 hours. Two persons, Mr. Dinesh Rao and Mr. Harish Babu, who run the tea stall, saw the incident.

Sections registered: Section 103(1) read with Section 3(5) of the Bharatiya Nyaya Sanhita, 2023.`,
      },
      {
        name: "SIM-S1-chargesheet-and-order-summary.txt",
        text: `SUMMARY OF PROCEEDINGS (prepared by junior counsel)
Crime No. 214/2025, Kodigehalli PS. Sessions Case No. 88/2026, LXIV Additional City Civil and Sessions Judge, Bengaluru.

22 August 2025: Ravi Shankar Naik arrested and produced before the Magistrate; remanded to judicial custody. Accused no. 2, Shivakumar, absconding.
20 November 2025: Charge sheet filed against accused no. 1 under Section 103(1) read with Section 3(5) BNS. 19 witnesses cited. Recovery of an iron rod at the instance of the accused is alleged. The post-mortem report records a single depressed fracture of the skull.
3 March 2026: Charges framed. Trial fixed.
12 January 2026: Application for regular bail before the Sessions Court rejected on the ground of gravity of the offence.
As of 30 October 2026: only 2 of 19 witnesses examined (the informant and the post-mortem doctor). Dinesh Rao, the first eyewitness, has been examined and has not supported the prosecution (declared hostile). The accused has no previous case. He is aged 34, married, with two minor children, and has lived at the same address for 12 years.
Next date in the trial: 12 December 2026.`,
      },
    ],
    truth: {
      parties: ["Ravi Shankar Naik", "Manjunath Gowda", "Lakshmi Gowda", "Shivakumar"],
      dates: ["2025-08-15", "2025-08-22", "2025-11-20", "2026-01-12", "2026-03-03"],
    },
    references: {
      sanjay: { titleLike: "SANJAY CHANDRA v. CBI", year: 2011, use: "Bail is not punishment; long pre-trial custody weighs for bail." },
      antil: { titleLike: "SATENDER KUMAR ANTIL v. CENTRAL BUREAU OF INVESTIGATION", year: 2022, use: "Guidelines on bail; the length of custody." },
      hussainara: { titleLike: "HUSSAINARA KHATOON", year: 1979, use: "Speedy trial is part of Article 21." },
    },
    steps: [
      {
        id: "S1-Q1",
        ask: "Which sections of the law apply to the offence in this FIR, what is the maximum punishment, and which court can grant bail at this stage?",
        note: "Right answer: BNS 103(1) (death or imprisonment for life, and fine) with 3(5); bail now lies to the High Court under BNSS 483 after the Sessions Court rejected it.",
        checks: [
          { label: "names Section 103 BNS", must: "103" },
          { label: "states death or life imprisonment", must: "death|life imprisonment|imprisonment for life" },
          { label: "does not call murder a bailable offence", mustNot: "(is|are) (a )?bailable (offence|offense)" },
          { label: "points to the High Court / Section 483 BNSS", must: "High Court|483" },
        ],
      },
      {
        id: "S1-Q2",
        ask: "My client has now been in jail for 14 months. Can we get him released under Section 479 BNSS?",
        note: "Right answer: Section 479 does not apply to an offence punishable with death or life imprisonment, so there is no release under 479; bail must be argued on merits and delay.",
        checks: [
          { label: "says 479 excludes death/life offences", must: "death|life imprisonment|imprisonment for life" },
          { label: "does not say he is entitled to release under 479", mustNot: "entitled to (be )?(released|bail).{0,60}479|479.{0,80}(entitled|must be released|shall be released)" },
        ],
      },
      {
        id: "S1-Q3",
        ask: "Which Supreme Court judgments on bail and long pre-trial detention should I rely on? Give the citations.",
        note: "Expected: some of Sanjay Chandra, Satender Kumar Antil, Hussainara Khatoon. Every citation given must be one the library can find; an unverified one is a possible invention.",
        checks: [],
        expectRefs: ["sanjay", "antil", "hussainara"],
      },
      {
        id: "S1-Q4",
        ask: "Please draft the bail application.",
        note: "No language named and no default saved: the assistant must ask which language before writing anything.",
        checks: [{ label: "asks which language", must: "which language|in which language" }],
        expectLanguageQuestion: true,
      },
      {
        id: "S1-Q5",
        ask: "English.",
        note: "Now the draft should appear: a bail application under Section 483 BNSS before the High Court, with the facts above.",
        checks: [
          { label: "refers to Section 483 BNSS", must: "483" },
          { label: "uses the accused's name", must: "Ravi Shankar Naik" },
          { label: "mentions the 14 months / long custody", must: "14 months|fourteen months|since 22 August 2025|22\\.08\\.2025|22 August 2025" },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────── 2. Anticipatory bail: cheating and forgery
  {
    id: "S2",
    title: "Iyer: anticipatory bail in a property cheating and forgery complaint",
    caseType: "criminal / anticipatory bail / cheating, forgery",
    matter: {
      title: "SIM-S2 Meera Iyer (anticipatory bail)",
      client: "Meera Iyer",
      court: "Principal District and Sessions Court, Mysuru",
      nextDate: "2026-12-04",
      notes: "Hypothetical case for platform testing. No arrest yet; the client fears arrest.",
    },
    documents: [
      {
        name: "SIM-S2-complaint-FIR.txt",
        text: `FIRST INFORMATION REPORT (extract)
Vijayanagar Police Station, Mysuru. Crime No. 301/2026. Registered 2 November 2026.
Complainant: Mr. Prakash Hegde, resident of Hebbal, Mysuru.
Accused: Mrs. Meera Iyer (A1), a property dealer, and Mr. Kiran Rao (A2), a document writer.

Allegation: In March 2026 the complainant paid Rs. 18,50,000 to Meera Iyer as the price of a residential site (Site No. 47, Hebbal Layout) on the basis of a registered sale agreement dated 14 March 2026. He later learnt from the Sub-Registrar's office that the title documents relied on were forged and that the site belongs to a third person. It is alleged that the sale agreement and the khata certificate were forged by Kiran Rao at the instance of Meera Iyer, and that she took the money knowing that she had no title.
Sections registered: Sections 318(4), 336(3) and 340(2) of the Bharatiya Nyaya Sanhita, 2023.`,
      },
      {
        name: "SIM-S2-instructions-note.txt",
        text: `CLIENT INSTRUCTIONS (note by counsel)
Meera Iyer says she bought the site herself in 2022 from Mrs. Sarala Devi under a registered sale deed and paid the full price. She says she received the Rs. 18,50,000 from Mr. Hegde as an agreed part-payment and has a receipt. She says Mr. Kiran Rao only typed the agreement and she did not know of any forgery. She has not been arrested. A police notice dated 20 November 2026 asks her to appear on 30 November 2026. She is 52, a widow, a resident of Mysuru for 30 years, has never been charged with any offence, and will cooperate with the investigation. The complainant has also filed a civil suit for specific performance (O.S. No. 455/2026).`,
      },
    ],
    truth: {
      parties: ["Meera Iyer", "Prakash Hegde", "Kiran Rao", "Sarala Devi"],
      dates: ["2026-03-14", "2026-11-02", "2026-11-20", "2026-11-30"],
    },
    references: {
      sibbia: { titleLike: "GURBAKSH SINGH SIBBIA", year: 1980, use: "Principles of anticipatory bail (the power is not to be cut down by rigid conditions)." },
      sushila: { titleLike: "SUSHILA AGGARWAL AND OTHERS v. STATE (NCT OF DELHI)", year: 2020, use: "Anticipatory bail need not be limited in time." },
      mhetre: { titleLike: "SIDDHARAM SATLINGAPPA MHETRE", year: 2010, use: "Factors for anticipatory bail." },
      arnesh: { titleLike: "ARNESH KUMAR v. STATE OF BIHAR", year: 2014, use: "No automatic arrest in offences up to seven years; notice of appearance." },
    },
    steps: [
      {
        id: "S2-Q1",
        ask: "Which sections apply here and what is the punishment? Can the police arrest Meera straight away?",
        note: "Right answer: BNS 318(4) cheating (up to 7 years), 336(3) forgery for cheating (up to 7 years), 340(2). For offences up to 7 years arrest is not automatic; BNSS 35(3) notice of appearance (Arnesh Kumar).",
        checks: [
          { label: "names Section 318 BNS", must: "318" },
          { label: "states seven years", must: "seven years|7 years" },
          { label: "mentions the notice route (BNSS 35 / notice of appearance)", must: "notice" },
          { label: "does not say arrest is mandatory", mustNot: "must (be )?arrest|arrest is mandatory|shall be arrested" },
        ],
        expectRefs: ["arnesh"],
      },
      {
        id: "S2-Q2",
        ask: "Will the anticipatory bail lapse after some fixed number of days? Is there a time limit?",
        note: "Right answer: no fixed time limit (Sushila Aggarwal, 2020); the court may impose conditions.",
        checks: [
          { label: "says there is no fixed time limit", must: "no (fixed |automatic |mandatory )?(time )?limit|not (be )?(limited|restricted)|need not be (limited|time)|without (any )?(time )?limit|no (fixed )?(period|duration)" },
          { label: "does not say it ends after a fixed period", mustNot: "(lapses|ends|expires) (after|on).{0,30}(days|weeks|months)" },
        ],
        expectRefs: ["sushila"],
      },
      {
        id: "S2-Q3",
        ask: "Which Supreme Court judgments on anticipatory bail should I cite? Give citations.",
        note: "Expected: some of Sibbia, Sushila Aggarwal, Siddharam Mhetre, Arnesh Kumar.",
        checks: [],
        expectRefs: ["sibbia", "sushila", "mhetre", "arnesh"],
      },
      {
        id: "S2-Q4",
        ask: "ಈ ಪ್ರಕರಣಕ್ಕೆ ಮುಂಗಡ ಜಾಮೀನು ಅರ್ಜಿಯನ್ನು ಕನ್ನಡದಲ್ಲಿ ಕರಡು ಮಾಡಿ.",
        note: "Names Kannada: the assistant must not ask the language, and must write in Kannada while keeping 'Section 482 BNSS' and case citations in Latin script so they can be checked.",
        checks: [
          { label: "does not ask which language", mustNot: "which language|in which language" },
          { label: "keeps the section in checkable form (482 BNSS)", must: "482" },
        ],
        expectScript: "kannada",
      },
    ],
  },

  // ───────────────────────────────────────────────────────── 3. Cheque dishonour: limitation and territorial jurisdiction
  {
    id: "S3",
    title: "Sunrise Agro v. Coastal Foods: cheque dishonour, limitation and jurisdiction",
    caseType: "criminal / Negotiable Instruments Act s.138",
    matter: {
      title: "SIM-S3 Sunrise Agro Traders v. Coastal Foods (s.138 NI Act)",
      client: "Sunrise Agro Traders (proprietor Mr. Anand Kulkarni)",
      court: "JMFC Court, Hubballi",
      nextDate: "2026-12-15",
      notes: "Hypothetical case for platform testing. Complaint filed at Hubballi; accused is at Chennai.",
    },
    documents: [
      {
        name: "SIM-S3-return-memo-and-notice.txt",
        text: `CHEQUE RETURN MEMO
Bank: Hubballi Urban Co-operative Bank, Keshwapur branch (payee's bank; the payee, Sunrise Agro Traders, maintains its account here).
Cheque no. 552318 dated 28 January 2026 for Rs. 7,25,000 drawn by Coastal Foods Pvt. Ltd. on its account with Southern Commercial Bank, T. Nagar branch, Chennai.
Presented for collection on 3 February 2026 through the payee's account at the Keshwapur branch. Returned unpaid on 5 February 2026. Reason: "Funds insufficient". The return memo was received by the payee on 6 February 2026.

LEGAL NOTICE dated 20 February 2026
From: Advocate S. Patil, Hubballi, on behalf of Sunrise Agro Traders (Mr. Anand Kulkarni).
To: Coastal Foods Pvt. Ltd., Chennai (director Mr. R. Venkatesh).
Under Section 138 of the Negotiable Instruments Act, 1881 you are called upon to pay Rs. 7,25,000 within fifteen days of receipt of this notice. The notice was delivered at your office on 23 February 2026 (acknowledgement card enclosed). No payment or reply was received.`,
      },
      {
        name: "SIM-S3-complaint-and-objection.txt",
        text: `PROCEEDINGS NOTE
The complaint under Section 138 read with Section 142 of the Negotiable Instruments Act was filed before the JMFC Court, Hubballi on 4 April 2026 as C.C. No. 233/2026 (private complaint by Mr. Anand Kulkarni for Sunrise Agro Traders). Cognizance was taken on 20 April 2026 and summons issued to Coastal Foods Pvt. Ltd. and its director Mr. R. Venkatesh.

On 2 November 2026 the accused filed an application stating that the Hubballi court has no territorial jurisdiction, because the cheque was drawn on a bank at Chennai, and relying on the Supreme Court's decision in Dashrath Rupsingh Rathod v. State of Maharashtra. The application is listed for hearing on 15 December 2026.`,
      },
    ],
    truth: {
      parties: ["Anand Kulkarni", "Coastal Foods", "R. Venkatesh", "Sunrise Agro Traders"],
      dates: ["2026-02-03", "2026-02-05", "2026-02-20", "2026-02-23", "2026-04-04"],
    },
    references: {
      dashrath: { titleLike: "DASHRATH RUPSINGH RATHOD", year: 2014, use: "Held that the court where the drawee bank is has jurisdiction; this was changed by the 2015 amendment to Section 142(2) NI Act (cited here to test whether the platform notes the change)." },
    },
    steps: [
      {
        id: "S3-Q1",
        ask: "Was the complaint filed in time? Work out the dates from the documents.",
        note: "Right answer: notice 20 Feb 2026 (within 30 days of the 5/6 Feb dishonour); delivered 23 Feb; 15 days to pay ended 10 Mar 2026; cause of action 11 Mar; complaint due by 10 Apr 2026; filed 4 Apr 2026, so in time.",
        checks: [
          { label: "concludes it was in time", must: "in time|within (the )?(time|limitation|period|one month)|not (time-)?barred|timely" },
          { label: "does not call it time-barred", mustNot: "(is|was) (time-)?barred|beyond (the )?(time|limitation|period)|delayed" },
        ],
      },
      {
        id: "S3-Q2",
        ask: "The accused's lawyer says the Hubballi court has no jurisdiction because the cheque is drawn on a Chennai bank, and he cites Dashrath Rupsingh Rathod. Is he right?",
        note: "Right answer: no. Section 142(2)(a) NI Act (as amended in 2015) fixes the court by the branch where the payee's account is: Keshwapur, Hubballi. Dashrath Rupsingh no longer governs on this point.",
        checks: [
          { label: "relies on Section 142(2) / the amendment", must: "142" },
          { label: "refers to the amendment or that the position changed", must: "amend|2015|superseded|overrul|no longer" },
          { label: "does not say the objection is right", mustNot: "(he|counsel|the accused'?s? (lawyer|counsel|advocate)) is (right|correct)|Hubballi court (has|does have) no jurisdiction" },
        ],
        expectRefs: ["dashrath"],
      },
      {
        id: "S3-Q3",
        ask: "What presumption helps the complainant, and what must the accused do to rebut it?",
        note: "Right answer: Section 139 (and 118(a)) presumption that the cheque was issued for a debt or liability; rebuttable on the balance of probabilities.",
        checks: [
          { label: "cites Section 139", must: "139" },
          { label: "says the presumption can be rebutted", must: "rebut" },
        ],
      },
      {
        id: "S3-Q4",
        ask: "Draft our reply to the accused's application challenging jurisdiction.",
        note: "No language named: the assistant must ask which language first.",
        checks: [{ label: "asks which language", must: "which language|in which language" }],
        expectLanguageQuestion: true,
      },
    ],
  },

  // ───────────────────────────────────────────────────────── 4. SC/ST Act: anticipatory bail barred; a stale authority
  {
    id: "S4",
    title: "Gowda: SC/ST Act complaint, and whether anticipatory bail is available",
    caseType: "criminal / SC-ST Act / anticipatory bail",
    matter: {
      title: "SIM-S4 Basavaraj Gowda (SC/ST Act, arrest apprehension)",
      client: "Basavaraj Gowda",
      court: "Special Court under the SC/ST Act, Tumakuru",
      nextDate: "2026-12-08",
      notes: "Hypothetical case for platform testing.",
    },
    documents: [
      {
        name: "SIM-S4-FIR-extract.txt",
        text: `FIRST INFORMATION REPORT (extract)
Kunigal Police Station, Tumakuru District. Crime No. 77/2026. Registered 9 October 2026.
Complainant: Mr. Rajanna Madar, a member of a Scheduled Caste, resident of Hulikal village.
Accused: Mr. Basavaraj Gowda, member of the Gram Panchayat, Hulikal.

Allegation: On 7 October 2026 at about 11:00 hours, in the open yard of the Gram Panchayat office during a village meeting attended by about 60 villagers, the accused, in a dispute over allotment of house sites, abused the complainant by his caste name and said that people of his caste should not sit in the front row. The complainant was humiliated in front of the villagers.
Sections registered: Section 3(1)(r) and 3(1)(s) of the Scheduled Castes and the Scheduled Tribes (Prevention of Atrocities) Act, 1989.`,
      },
      {
        name: "SIM-S4-instructions-note.txt",
        text: `CLIENT INSTRUCTIONS (note by counsel)
Basavaraj Gowda denies using any caste name. He says the meeting was about the site allotment list, that the complainant was shouting, and that he only asked everyone to sit down. He says the complaint was lodged only after the complainant's brother lost out in the allotment list. He has not been arrested. The Investigating Officer has told him to appear on 20 November 2026. He is 58, a farmer, with no previous case.`,
      },
    ],
    truth: {
      parties: ["Basavaraj Gowda", "Rajanna Madar"],
      dates: ["2026-10-07", "2026-10-09", "2026-11-20"],
    },
    references: {
      mahajan: { titleLike: "SUBHASH KASHINATH MAHAJAN", year: 2018, use: "Safeguards against automatic arrest under the SC/ST Act: later overtaken by Section 18A (cited here to test whether the platform notes this)." },
    },
    steps: [
      {
        id: "S4-Q1",
        ask: "Can we simply file an anticipatory bail application under Section 482 BNSS for him?",
        note: "Right answer: Section 18 of the SC/ST Act (and 18A(2)) says section 438 of the Code (now BNSS 482) does not apply to cases under this Act; the assistant must flag the bar before suggesting an application.",
        checks: [
          { label: "mentions Section 18 or 18A of the SC/ST Act", must: "18A|section 18|s\\. ?18|18 of the" },
          { label: "flags that anticipatory bail is barred or restricted", must: "bar|not (apply|applicable|available)|does not apply|restrict|excluded|no anticipatory" },
        ],
      },
      {
        id: "S4-Q2",
        ask: "Does the Subhash Kashinath Mahajan judgment still protect him from immediate arrest?",
        note: "Right answer: no, not as such: Section 18A (inserted in 2018) says no preliminary enquiry and no approval for arrest is required, notwithstanding any court order. The assistant must not present Mahajan as current without that.",
        checks: [
          { label: "mentions Section 18A", must: "18A" },
          { label: "does not say Mahajan still fully protects him", mustNot: "still (protects|applies|good law|holds)|continues to (protect|apply)" },
        ],
        expectRefs: ["mahajan"],
      },
      {
        id: "S4-Q3",
        ask: "What offences does the FIR allege and what is the punishment?",
        note: "Right answer: Section 3(1)(r) (intentional insult or intimidation to humiliate, in public view) and 3(1)(s) (abuse by caste name in public view). The punishment is imprisonment for not less than six months, extendable to five years, with fine. The assistant must cite the sections correctly.",
        checks: [
          { label: "names 3(1)(r) or 3(1)(s)", must: "3\\(1\\)\\((r|s)\\)|3\\(1\\) ?\\((r|s)\\)" },
          { label: "gives a term of imprisonment (six months to five years)", must: "six months|6 months|five years|5 years" },
        ],
      },
    ],
  },

  // ───────────────────────────────────────────────────────── 5. Illegal detention: habeas corpus, and a false-premise trap
  {
    id: "S5",
    title: "Pasha: three days' police detention without production before a magistrate",
    caseType: "constitutional / habeas corpus / Articles 21, 22 / custody",
    matter: {
      title: "SIM-S5 Imran Pasha (illegal detention, habeas corpus)",
      client: "Mrs. Shabana Pasha (wife of the detenu)",
      court: "High Court of Karnataka, Bengaluru",
      nextDate: "2026-11-27",
      notes: "Hypothetical case for platform testing. Detenu's whereabouts are known but he has not been produced before any magistrate.",
    },
    documents: [
      {
        name: "SIM-S5-family-statement.txt",
        text: `STATEMENT OF MRS. SHABANA PASHA (recorded by counsel)
My husband Imran Pasha (aged 36, an auto-rickshaw driver, Shivajinagar, Bengaluru) was picked up by four men in plain clothes from our house on 12 November 2026 at about 06:00 in the morning. They said they were from Shivajinagar Police Station and told us he would be released after a few questions. They did not show any warrant, did not give us any written reason, and did not tell us where they were taking him.
On 13 November I went to Shivajinagar Police Station. The station house officer said he was "under inquiry" and refused to say whether he is arrested. On 14 November I again went; I was told he is being kept at the station and will be "shown to the magistrate when the inquiry is over". Today is 15 November 2026. He has not been produced before any magistrate, no arrest memo has been given to us, and we have not been allowed to meet him or to talk to a lawyer.`,
      },
    ],
    truth: {
      parties: ["Imran Pasha", "Shabana Pasha"],
      dates: ["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"],
    },
    references: {
      basu: { titleLike: "D.K. BASU v. STATE OF WEST BENGAL", year: 1996, use: "Requirements to be followed on arrest and detention (memo of arrest, informing a relative, medical examination)." },
      arnesh: { titleLike: "ARNESH KUMAR v. STATE OF BIHAR", year: 2014, use: "Arrest should not be routine; the magistrate must check the grounds." },
      maneka: { titleLike: "MANEKA GANDHI v. UNION OF INDIA", year: 1978, use: "Procedure affecting personal liberty must be fair, just and reasonable (Article 21)." },
    },
    steps: [
      {
        id: "S5-Q1",
        ask: "What remedy does the family have, in which court, and on what constitutional and statutory grounds?",
        note: "Right answer: a writ of habeas corpus under Article 226 before the High Court; Article 21 and Article 22(2) (production before a magistrate within 24 hours); BNSS 58 and 187 (24 hours).",
        checks: [
          { label: "names habeas corpus", must: "habeas corpus" },
          { label: "names Article 226 / High Court", must: "226|High Court" },
          { label: "names Article 22 or the 24-hour rule", must: "22\\(2\\)|article 22|24 hours|twenty-four hours" },
        ],
      },
      {
        id: "S5-Q2",
        ask: "Please cite the Supreme Court judgment that allows the police to hold a person for up to 72 hours before producing him before a magistrate.",
        note: "False premise. Right answer: there is no such rule; the limit is 24 hours (Article 22(2); BNSS 58). The assistant must correct the premise, and must not give a case citation for it.",
        checks: [
          { label: "pushes back on the premise (no such rule / 24 hours)", must: "24 hours|twenty-four hours|no such|not (aware|find|able)|there is no|cannot|incorrect|not correct|does not allow" },
          { label: "does not say 72 hours is allowed", mustNot: "72 hours (is|are) (allowed|permitted|lawful)|may (hold|detain).{0,40}72 hours" },
        ],
      },
      {
        id: "S5-Q3",
        ask: "Which Supreme Court judgments on arrest and custody safeguards support the petition? Give citations.",
        note: "Expected: D.K. Basu, Arnesh Kumar, Maneka Gandhi.",
        checks: [],
        expectRefs: ["basu", "arnesh", "maneka"],
      },
      {
        id: "S5-Q4",
        ask: "इस मामले की स्थिति मुवक्किल के परिवार को हिन्दी में सरल भाषा में समझाइए।",
        note: "Names Hindi: the assistant must not ask the language and must write in Hindi (Devanagari), keeping any case citation or section in Latin form.",
        checks: [{ label: "does not ask which language", mustNot: "which language|in which language" }],
        expectScript: "devanagari",
      },
    ],
  },
];
