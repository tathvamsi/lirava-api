import { getQdrant, upsertLegalChunks } from "./qdrant.js";
import { embedBatch } from "./embeddings.js";
import { config } from "../../config.js";
export const LEGAL_FOUNDATIONAL_CORPUS = [
    // --- BNSS, 2023 ---
    {
        id: "bnss-sec-480",
        act: "Bharatiya Nagarik Suraksha Sanhita (BNSS), 2023",
        section: "Section 480",
        title: "Bail in non-bailable offences (corresponds to old Sec 437 CrPC)",
        category: "criminal_procedure",
        year: 2023,
        statutoryText: "Section 480 BNSS: When any person accused of, or suspected of, the commission of any non-bailable offence is arrested or detained without warrant by an officer in charge of a police station, or appears or is brought before a Court other than the High Court or Court of Session, he may be released on bail, but he shall not be so released if there appear reasonable grounds for believing that he has been guilty of an offence punishable with death or imprisonment for life; Provided that the Court may direct that any person under the age of sixteen years or any woman or any sick or infirm person accused of such an offence be released on bail.",
        ratio: "Magisterial discretion to grant bail in non-bailable offences. Carves out special protective discretion for juveniles, women, sick, and infirm persons.",
        source: "Bare Act: Bharatiya Nagarik Suraksha Sanhita, 2023",
    },
    {
        id: "bnss-sec-482",
        act: "Bharatiya Nagarik Suraksha Sanhita (BNSS), 2023",
        section: "Section 482",
        title: "Direction for grant of bail to person apprehending arrest (Anticipatory Bail - corresponds to old Sec 438 CrPC)",
        category: "criminal_procedure",
        year: 2023,
        statutoryText: "Section 482 BNSS: Where any person has reason to believe that he may be arrested on accusation of having committed a non-bailable offence, he may apply to the High Court or the Court of Session for a direction under this section that in the event of such arrest he shall be released on bail; and that Court may, after taking into consideration the nature and gravity of the accusation, the antecedents of the applicant, the possibility of the applicant to flee from justice, and whether the accusation has been made with the object of injuring or humiliating the applicant, either reject the application forthwith or issue an interim order for the grant of anticipatory bail.",
        ratio: "Anticipatory bail safeguards personal liberty under Article 21 against frivolous or mala fide arrests. Imposes mandatory consideration of flight risk, antecedents, and gravity.",
        source: "Bare Act: Bharatiya Nagarik Suraksha Sanhita, 2023",
    },
    {
        id: "bnss-sec-483",
        act: "Bharatiya Nagarik Suraksha Sanhita (BNSS), 2023",
        section: "Section 483",
        title: "Special powers of High Court or Court of Session regarding bail (Regular Bail - corresponds to old Sec 439 CrPC)",
        category: "criminal_procedure",
        year: 2023,
        statutoryText: "Section 483 BNSS: A High Court or Court of Session may direct that any person accused of an offence and in custody be released on bail, and if the offence is of the nature specified in sub-section (3) of section 480, may impose any condition which it considers necessary for the purposes of that sub-section; A High Court or Court of Session may direct that any person who has been released on bail under this Chapter be arrested and commit him to custody.",
        ratio: "Overarching jurisdiction of Sessions Court and High Court to grant regular bail to an accused in judicial custody and to cancel bail where liberty has been abused.",
        source: "Bare Act: Bharatiya Nagarik Suraksha Sanhita, 2023",
    },
    {
        id: "bnss-sec-528",
        act: "Bharatiya Nagarik Suraksha Sanhita (BNSS), 2023",
        section: "Section 528",
        title: "Saving of inherent powers of High Court (Quashing of FIR / Proceedings - corresponds to old Sec 482 CrPC)",
        category: "criminal_procedure",
        year: 2023,
        statutoryText: "Section 528 BNSS: Nothing in this Sanhita shall be deemed to limit or affect the inherent powers of the High Court to make such orders as may be necessary to give effect to any order under this Sanhita, or to prevent abuse of the process of any Court or otherwise to secure the ends of justice.",
        ratio: "Inherent jurisdiction exercised to quash frivolous, vexatious, or malicious criminal proceedings where allegations do not disclose a cognizable offence or are civil disputes in criminal garb.",
        source: "Bare Act: Bharatiya Nagarik Suraksha Sanhita, 2023",
    },
    {
        id: "bnss-sec-35",
        act: "Bharatiya Nagarik Suraksha Sanhita (BNSS), 2023",
        section: "Section 35",
        title: "Notice of appearance before police officer in offences punishable up to seven years (corresponds to old Sec 41A CrPC)",
        category: "criminal_procedure",
        year: 2023,
        statutoryText: "Section 35 BNSS: The police officer shall, in all cases where the arrest of a person is not required under the provisions of sub-section (1), issue a notice directing the person against whom a reasonable complaint has been made, or credible information has been received, or a reasonable suspicion exists that he has committed a cognizable offence, to appear before him or at such other place as may be specified in the notice. Where such notice is issued to any person, it shall be the duty of that person to comply with the terms of the notice.",
        ratio: "Mandatory restraint on arrest for offences punishable up to seven years unless recording reasons under Arnesh Kumar / Satender Kumar Antil principles.",
        source: "Bare Act: Bharatiya Nagarik Suraksha Sanhita, 2023",
    },
    {
        id: "bnss-sec-193",
        act: "Bharatiya Nagarik Suraksha Sanhita (BNSS), 2023",
        section: "Section 193",
        title: "Report of police officer on completion of investigation / Chargesheet (corresponds to old Sec 173 CrPC)",
        category: "criminal_procedure",
        year: 2023,
        statutoryText: "Section 193 BNSS: Every investigation under this Chapter shall be completed without unnecessary delay. As soon as it is completed, the officer in charge of the police station shall forward to a Magistrate empowered to take cognizance of the offence on a police report, a report in the form prescribed by the State Government, stating the names of the parties, nature of the information, whether the accused has been arrested, forwarded in custody, or released on bond.",
        ratio: "Statutory completion of police investigation and filing of final report / chargesheet forming foundation for magisterial cognizance.",
        source: "Bare Act: Bharatiya Nagarik Suraksha Sanhita, 2023",
    },
    // --- BNS, 2023 ---
    {
        id: "bns-sec-103",
        act: "Bharatiya Nyaya Sanhita (BNS), 2023",
        section: "Section 103",
        title: "Punishment for Murder (corresponds to old IPC 302)",
        category: "penal_code",
        year: 2023,
        statutoryText: "Section 103 BNS: (1) Whoever commits murder shall be punished with death or imprisonment for life, and shall also be liable to fine. (2) When a group of five or more persons acting in concert commits murder on the ground of race, caste or community, sex, place of birth, language, personal belief or any other similar ground, each member of such group shall be punished with death or with imprisonment for life, and shall also be liable to fine.",
        ratio: "Substantive penal section for murder with distinct classification and severe penalties for mob lynchings and group killings based on identity.",
        source: "Bare Act: Bharatiya Nyaya Sanhita, 2023",
    },
    {
        id: "bns-sec-316",
        act: "Bharatiya Nyaya Sanhita (BNS), 2023",
        section: "Section 316",
        title: "Criminal breach of trust (corresponds to old IPC 405 & 406)",
        category: "penal_code",
        year: 2023,
        statutoryText: "Section 316 BNS: (1) Whoever, being in any manner entrusted with property, or with any dominion over property, dishonestly misappropriates or converts to his own use that property, or dishonestly uses or disposes of that property in violation of any direction of law prescribing the mode in which such trust is to be discharged, commits criminal breach of trust. (2) Whoever commits criminal breach of trust shall be punished with imprisonment of either description for a term which may extend to five years, or with fine, or with both.",
        ratio: "Essential ingredient: Entrustment followed by dishonest misappropriation or conversion for personal use.",
        source: "Bare Act: Bharatiya Nyaya Sanhita, 2023",
    },
    {
        id: "bns-sec-318",
        act: "Bharatiya Nyaya Sanhita (BNS), 2023",
        section: "Section 318",
        title: "Cheating and dishonestly inducing delivery of property (corresponds to old IPC 415 & 420)",
        category: "penal_code",
        year: 2023,
        statutoryText: "Section 318 BNS: (1) Whoever, by deceiving any person, fraudulently or dishonestly induces the person so deceived to deliver any property to any person, or to consent that any person shall retain any property... is said to cheat. (4) Whoever cheats and thereby dishonestly induces the person deceived to deliver any property to any person... shall be punished with imprisonment of either description for a term which may extend to seven years, and shall also be liable to fine.",
        ratio: "Fraudulent or dishonest intention must exist at the inception of the transaction; mere failure to perform a contract does not constitute cheating.",
        source: "Bare Act: Bharatiya Nyaya Sanhita, 2023",
    },
    // --- BSA, 2023 ---
    {
        id: "bsa-sec-61",
        act: "Bharatiya Sakshya Adhiniyam (BSA), 2023",
        section: "Section 61",
        title: "Admissibility of electronic or digital records",
        category: "evidence",
        year: 2023,
        statutoryText: "Section 61 BSA: Nothing in this Adhiniyam shall apply to deny the admissibility of an electronic or digital record in the evidence on the ground that it is an electronic or digital record and such record shall have the same legal effect, validity and enforceability as other document.",
        ratio: "Establishes full legal equivalence and evidentiary parity between physical paper documents and digital/electronic records.",
        source: "Bare Act: Bharatiya Sakshya Adhiniyam, 2023",
    },
    {
        id: "bsa-sec-63",
        act: "Bharatiya Sakshya Adhiniyam (BSA), 2023",
        section: "Section 63",
        title: "Admissibility of electronic records and requirement of certificate (corresponds to old Sec 65B Indian Evidence Act)",
        category: "evidence",
        year: 2023,
        statutoryText: "Section 63 BSA: (1) Any information contained in an electronic record which is printed on a paper, stored, recorded or copied in optical or magnetic media or cloud or database produced by a computer shall be deemed to be also a document... (4) In any proceedings where it is desired to give a statement in evidence by virtue of this section, a certificate doing any of the following things, that is to say, identifying the electronic record containing the statement and describing the manner in which it was produced, giving such particulars of any device involved, signed by a person in charge or responsible official, shall be submitted accompanied by the electronic record.",
        ratio: "Mandatory statutory certificate requirement for electronic evidence. Replaces Section 65B(4) of Indian Evidence Act, 1872 pursuant to Arjun Panditrao Khotkar principles.",
        source: "Bare Act: Bharatiya Sakshya Adhiniyam, 2023",
    },
    // --- Negotiable Instruments Act, 1881 ---
    {
        id: "ni-act-sec-138",
        act: "Negotiable Instruments Act, 1881",
        section: "Section 138",
        title: "Dishonour of cheque for insufficiency of funds in the accounts",
        category: "commercial",
        year: 1881,
        statutoryText: "Section 138 NI Act: Where any cheque drawn by a person on an account maintained by him with a banker for payment of any amount of money to another person from out of that account for the discharge, in whole or in part, of any debt or other liability, is returned by the bank unpaid, either because of the amount of money standing to the credit of that account is insufficient... such person shall be deemed to have committed an offence. Provided that: (a) cheque presented within three months; (b) payee makes a demand for payment by giving a notice in writing within thirty days of the receipt of information of dishonour; (c) drawer fails to make payment within fifteen days of receipt of said notice.",
        ratio: "Strict liability offence. Cause of action arises only after expiration of 15 days from receipt of statutory demand notice. Complaint must be filed within 1 month thereafter under Section 142.",
        source: "Bare Act: Negotiable Instruments Act, 1881",
    },
    {
        id: "ni-act-sec-139",
        act: "Negotiable Instruments Act, 1881",
        section: "Section 139",
        title: "Presumption in favour of holder of cheque",
        category: "commercial",
        year: 1881,
        statutoryText: "Section 139 NI Act: It shall be presumed, unless the contrary is proved, that the holder of a cheque received the cheque of the nature referred to in section 138 for the discharge, in whole or in part, of any debt or other liability.",
        ratio: "Rebuttable statutory presumption shifting the evidentiary burden onto the accused to establish probable defence through preponderance of probabilities (Basalingappa v. Mudibasappa).",
        source: "Bare Act: Negotiable Instruments Act, 1881",
    },
    {
        id: "ni-act-sec-141",
        act: "Negotiable Instruments Act, 1881",
        section: "Section 141",
        title: "Offences by companies and vicarious liability of directors",
        category: "commercial",
        year: 1881,
        statutoryText: "Section 141 NI Act: (1) If the person committing an offence under section 138 is a company, every person who, at the time the offence was committed, was in charge of, and was responsible to the company for the conduct of the business of the company, as well as the company, shall be deemed to be guilty of the offence and shall be liable to be proceeded against and punished accordingly.",
        ratio: "Specific averments in the complaint showing the director was actively in charge of and responsible for the company's affairs at the time of cheque issuance are mandatory (SMS Pharmaceuticals).",
        source: "Bare Act: Negotiable Instruments Act, 1881",
    },
    // --- CPC, 1908 ---
    {
        id: "cpc-o39-r1-2",
        act: "Code of Civil Procedure (CPC), 1908",
        section: "Order XXXIX Rules 1 & 2",
        title: "Cases in which temporary injunction may be granted",
        category: "civil_procedure",
        year: 1908,
        statutoryText: "Order XXXIX Rule 1 CPC: Where in any suit it is proved by affidavit or otherwise: (a) that any property in dispute in a suit is in danger of being wasted, damaged or alienated by any party to the suit, or wrongfully sold in execution of a decree, or (b) that the defendant threatens, or intends, to remove or dispose of his property with a view to defrauding his creditors... the Court may by order grant a temporary injunction to restrain such act. Rule 2: Injunction to restrain repetition or continuance of breach of contract or injury.",
        ratio: "The Tripartite Injunction Test: Grant of interim injunction requires simultaneous satisfaction of (1) Prima facie case, (2) Balance of convenience, and (3) Irreparable injury not compensable in damages.",
        source: "Bare Act: Code of Civil Procedure, 1908",
    },
    {
        id: "cpc-o7-r11",
        act: "Code of Civil Procedure (CPC), 1908",
        section: "Order VII Rule 11",
        title: "Rejection of Plaint",
        category: "civil_procedure",
        year: 1908,
        statutoryText: "Order VII Rule 11 CPC: The plaint shall be rejected in the following cases: (a) where it does not disclose a cause of action; (b) where the relief claimed is undervalued; (c) where the plaint is written upon paper insufficiently stamped; (d) where the suit appears from the statement in the plaint to be barred by any law.",
        ratio: "Plaint can be rejected in limine if averments on the face of the plaint disclose no cause of action or show the suit is barred by limitation or statutory prohibition (Dahiben v. Arvindbhai Kalyanji Bhanusali).",
        source: "Bare Act: Code of Civil Procedure, 1908",
    },
    // --- Limitation Act, 1963 ---
    {
        id: "limitation-sec-5",
        act: "Limitation Act, 1963",
        section: "Section 5",
        title: "Extension of prescribed period in certain cases (Condonation of Delay)",
        category: "limitation",
        year: 1963,
        statutoryText: "Section 5 Limitation Act: Any appeal or any application, other than an application under any of the provisions of Order XXI of the Code of Civil Procedure, 1908, may be admitted after the prescribed period if the appellant or the applicant satisfies the court that he had sufficient cause for not preferring the appeal or making the application within such period.",
        ratio: "Sufficient cause must be shown for every day of delay; courts adopt a pragmatic and justice-oriented approach rather than a pedantic one (Collector, Land Acquisition, Anantnag v. Mst. Katiji).",
        source: "Bare Act: Limitation Act, 1963",
    },
    // --- Landmark Supreme Court Ratios ---
    {
        id: "sc-satender-antil-2022",
        act: "Supreme Court of India Precedent",
        section: "Bail Jurisprudence & Arrest Guidelines",
        title: "Satender Kumar Antil v. Central Bureau of Investigation, (2022) 10 SCC 51",
        category: "judicial_precedent",
        court: "Supreme Court of India",
        year: 2022,
        statutoryText: "Supreme Court ruling in Satender Kumar Antil v. CBI: Reaffirmed that 'Bail is the rule, jail is the exception'. Categorized offences into: Category A (punishable up to 7 years imprisonment without custody warrant unless notice under Sec 41A CrPC / Sec 35 BNSS is violated); Category B (death/life imprisonment); Category C (special acts like NDPS, PMLA, POCSO); Category D (economic offences). Emphasized that personal liberty under Article 21 cannot be curtailed casually.",
        ratio: "Non-compliance with arrest guidelines (Sec 35 BNSS / Sec 41A CrPC) entitles the accused to bail. Incarceration before trial cannot be punitive.",
        source: "Judicial Citation: (2022) 10 SCC 51",
    },
    {
        id: "sc-bhajan-lal-1992",
        act: "Supreme Court of India Precedent",
        section: "Section 528 BNSS / Section 482 CrPC Quashing Framework",
        title: "State of Haryana v. Bhajan Lal, 1992 Supp (1) SCC 335",
        category: "judicial_precedent",
        court: "Supreme Court of India",
        year: 1992,
        statutoryText: "Supreme Court benchmark ruling in State of Haryana v. Bhajan Lal: Formulated 7 illustrative categories where inherent powers of High Court under Sec 482 CrPC (now Sec 528 BNSS) can be exercised: (1) Where allegations in FIR do not prima facie constitute any offence; (2) Where uncontroverted allegations disclose no cognizable offence; (3) Where evidence collected does not disclose commission of any offence; (4) Where allegations are absurd and inherently improbable; (5) Where proceeding is manifestly attended with mala fide or vengeance.",
        ratio: "Locus classicus on quashing criminal proceedings and FIRs to prevent abuse of the process of law and secure the ends of justice.",
        source: "Judicial Citation: 1992 Supp (1) SCC 335",
    },
    {
        id: "sc-arjun-panditrao-2020",
        act: "Supreme Court of India Precedent",
        section: "Electronic Evidence Certificate (Section 63 BSA / Section 65B IEA)",
        title: "Arjun Panditrao Khotkar v. Kailash Kushanrao Gorantyal, (2020) 7 SCC 1",
        category: "judicial_precedent",
        court: "Supreme Court of India",
        year: 2020,
        statutoryText: "Supreme Court Three-Judge Bench ruling in Arjun Panditrao Khotkar: Held that production of a certificate under Section 65B(4) of the Evidence Act (now Section 63(4) BSA, 2023) is mandatory as a condition precedent to the admissibility of evidence by way of electronic records. In absence of certificate, secondary electronic evidence (printouts, CDs, hard disks) cannot be exhibited or admitted in trial.",
        ratio: "Mandatory condition precedent: Certificate under Section 63 BSA is indispensable for proving electronic records in court.",
        source: "Judicial Citation: (2020) 7 SCC 1",
    },
    {
        id: "sc-dalpat-kumar-1992",
        act: "Supreme Court of India Precedent",
        section: "Interim Injunction Doctrine (Order 39 Rules 1 & 2 CPC)",
        title: "Dalpat Kumar v. Prahlad Singh, (1992) 1 SCC 719",
        category: "judicial_precedent",
        court: "Supreme Court of India",
        year: 1992,
        statutoryText: "Supreme Court ruling in Dalpat Kumar v. Prahlad Singh: Reaffirmed the three core prerequisites for granting temporary injunctions under Order 39 Rules 1 & 2 CPC: (1) Prima facie case (serious dispute to be tried); (2) Irreparable injury (injury that cannot be compensated adequately by damages); (3) Balance of convenience (greater hardship caused to applicant if refused than to respondent if granted).",
        ratio: "Prima facie case alone is not sufficient; irreparable injury and balance of convenience must also be concurrently proven by the plaintiff.",
        source: "Judicial Citation: (1992) 1 SCC 719",
    },
];
/**
 * Seeds foundational Indian statutory provisions and leading precedents
 * into the Qdrant `soli_legal_corpus` collection.
 */
export async function seedLegalCorpus(force = false) {
    const collectionName = config.qdrantCollection || "soli_legal_corpus";
    try {
        const qdrant = getQdrant();
        const info = await qdrant.getCollection(collectionName);
        const existingCount = info.points_count || 0;
        if (existingCount >= LEGAL_FOUNDATIONAL_CORPUS.length && !force) {
            console.log(`\x1b[32m[corpus-seeder]\x1b[0m Collection '${collectionName}' already seeded (${existingCount} points). Skipping.`);
            return { count: existingCount, status: "already_seeded" };
        }
        console.log(`\x1b[34m[corpus-seeder]\x1b[0m 🚀 Seeding ${LEGAL_FOUNDATIONAL_CORPUS.length} foundational legal chunks into '${collectionName}'...`);
        // Prepare texts for batch embedding
        const textsToEmbed = LEGAL_FOUNDATIONAL_CORPUS.map((item) => {
            return `${item.act} - ${item.section}: ${item.title}\n${item.statutoryText}\nRatio: ${item.ratio || ""}\nSource: ${item.source}`;
        });
        console.log(`\x1b[34m[corpus-seeder]\x1b[0m 🧠 Generating 1024-dim embeddings via local LLM server...`);
        const vectors = await embedBatch(textsToEmbed);
        const points = LEGAL_FOUNDATIONAL_CORPUS.map((item, index) => {
            // Deterministic numeric or UUID point ID
            return {
                id: index + 1001,
                vector: vectors[index],
                payload: {
                    act: item.act,
                    section: item.section,
                    title: item.title,
                    category: item.category,
                    text: textsToEmbed[index],
                    statutoryText: item.statutoryText,
                    ratio: item.ratio,
                    source: item.source,
                    court: item.court,
                    year: item.year,
                },
            };
        });
        await upsertLegalChunks(points);
        console.log(`\x1b[32m[corpus-seeder]\x1b[0m ✅ Successfully seeded ${points.length} legal knowledge points!`);
        return { count: points.length, status: "success" };
    }
    catch (err) {
        console.error(`\x1b[31m[corpus-seeder]\x1b[0m ❌ Seeding failed: ${err.message}`);
        return { count: 0, status: "error" };
    }
}
