/**
 * Soli Legal Knowledge & Chamber Intelligence Engine
 * Provides structured statutory analysis, procedural principles, and citations.
 */

export function generateLegalResponse(userText: string): string {
  const query = userText.toLowerCase();

  // 1. Casual / Greetings
  if (
    /^(hi|hello|hey|greetings|good\s*(morning|afternoon|evening)|who are you|what can you do|help me|can you help)/i.test(query.trim()) ||
    query.trim().length <= 6
  ) {
    return "Hello. I’m Lirava. How can I help with your legal matter today?";
  }

  // 2. Bail & Anticipatory Bail
  if (
    query.includes("bail") ||
    query.includes("480") ||
    query.includes("482") ||
    query.includes("483") ||
    query.includes("437") ||
    query.includes("438") ||
    query.includes("439") ||
    query.includes("arrest") ||
    query.includes("custody")
  ) {
    return `### Legal Analysis: Bail Provisions under BNSS, 2023

Under the statutory framework of the **Bharatiya Nagarik Suraksha Sanhita (BNSS), 2023**:
- **Section 480 BNSS** *(formerly Sec 437 CrPC)*: Bail in non-bailable offenses before the Magistrate.
- **Section 482 BNSS** *(formerly Sec 438 CrPC)*: Direction for grant of bail to person apprehending arrest (**Anticipatory Bail**) before the Sessions Court or High Court.
- **Section 483 BNSS** *(formerly Sec 439 CrPC)*: Special powers of the High Court or Court of Session regarding **Regular Bail**.

#### Essential Judicial Principles & Precedents
1. **"Bail is the Rule, Jail is an Exception":** Firmly reaffirmed in *Satender Kumar Antil v. CBI, (2022) 10 SCC 51* and *Sanjay Chandra v. CBI, (2012) 1 SCC 40*. Incarceration before conviction should not take the character of punishment.
2. **The Triple Test Threshold** (*P. Chidambaram v. CBI / ED, (2019)*):
   - **Flight Risk:** Applicant has established roots in society, fixed residence, and no propensity to abscond.
   - **Evidence Tampering:** Documentary evidence and case property are already under the custody of investigating authorities.
   - **Witness Intimidation:** No overt act or intimidation towards material prosecution witnesses.
3. **Pleading Checklist for the Application:**
   - Clear custody timeline and exact date of arrest.
   - Status of investigation (whether police report under Sec 193 BNSS has been filed).
   - Clean criminal antecedents and local solvent sureties.
   - Undertaking to adhere to all terms imposed by the Hon'ble Court.

*Would you like me to prepare a court-compliant draft of this bail application with cause title, facts, and formal prayers?*`;
  }

  // 3. Quashing of FIR / Criminal Proceedings
  if (
    query.includes("quash") ||
    query.includes("528") ||
    query.includes("fir") ||
    query.includes("inherent power") ||
    query.includes("bhajan lal") ||
    query.includes("abuse of process")
  ) {
    return `### Legal Framework: Inherent Powers to Quash Proceedings under Section 528 BNSS, 2023

Section **528 of the Bharatiya Nagarik Suraksha Sanhita (BNSS), 2023** *(corresponding to Section 482 CrPC, 1973)* preserves the inherent powers of the High Court to prevent abuse of the process of any court and to secure the ends of justice.

#### The Cardinal Principles (*State of Haryana v. Bhajan Lal, 1992 Supp (1) SCC 335*):
1. **No Prima Facie Offense:** Where the allegations in the FIR, even taken at face value, do not prima facie constitute any offense or make out a case against the accused.
2. **Inherently Improbable:** Where the allegations are so absurd or inherently improbable that no prudent person could arrive at a just conclusion of sufficient ground for proceeding.
3. **Mala Fide Prosecution:** Where the criminal proceeding is manifestly attended with mala fide or maliciously instituted with an ulterior motive for wreaking vengeance.
4. **Civil Cloak on Purely Commercial Disputes:** As established in *Indian Oil Corp v. NEPC India Ltd.* and *Prof. R.K. Vijayasarathy v. Sudha Seetharam (2019)*, purely commercial disputes or breaches of contract cannot be given a criminal complexion.

*If you provide the FIR number, registered offenses, and brief factual background, I can formulate the formal grounds of challenge for your petition.*`;
  }

  // 4. BNS & IPC Offenses
  if (
    query.includes("bns") ||
    query.includes("ipc") ||
    query.includes("318") ||
    query.includes("420") ||
    query.includes("cheating") ||
    query.includes("fraud") ||
    query.includes("103") ||
    query.includes("302") ||
    query.includes("316") ||
    query.includes("breach of trust") ||
    query.includes("murder")
  ) {
    return `### Statutory Analysis: Bharatiya Nyaya Sanhita (BNS), 2023

The **Bharatiya Nyaya Sanhita, 2023 (BNS)** replaces the Indian Penal Code, 1860, streamlining criminal jurisprudence into a consolidated statutory structure.

#### Key Statutory Concordance:
- **Cheating & Dishonestly Inducing Delivery:** Now **Section 318 BNS** *(formerly IPC 420)*.
  - *Essential Threshold:* A fraudulent or dishonest intention must exist at the inception of the contract; a subsequent inability to perform does not constitute a criminal offense (*Hridaya Ranjan Pd. Verma v. State of Bihar*).
- **Criminal Breach of Trust:** Now **Section 316 BNS** *(formerly IPC 405/406)*.
  - *Essential Threshold:* Entrustment of property followed by dishonest conversion or misappropriation.
- **Offenses Against Human Life:**
  - Murder: **Section 103 BNS** *(formerly IPC 302)*.
  - Culpable Homicide not amounting to murder: **Section 105 BNS** *(formerly IPC 304)*.
  - Voluntarily causing hurt: **Section 115 BNS** *(formerly IPC 323)*.
- **Organized Crime:** Enacted under **Section 111 & 112 BNS**.

*Do you require a comparative table of elements or specific defense arguments under these sections?*`;
  }

  // 5. Electronic Evidence & BSA
  if (
    query.includes("evidence") ||
    query.includes("electronic") ||
    query.includes("65b") ||
    query.includes("bsa") ||
    query.includes("certificate") ||
    query.includes("whatsapp") ||
    query.includes("call record")
  ) {
    return `### Admissibility of Electronic Records under Bharatiya Sakshya Adhiniyam (BSA), 2023

Under the **Bharatiya Sakshya Adhiniyam, 2023 (BSA)**:
- **Section 61 BSA:** Recognizes electronic and digital records as admissible documentary evidence.
- **Section 63 BSA** *(formerly Section 65B of the Indian Evidence Act, 1872)*: Governs the mandatory conditions and certification required for secondary electronic records.

#### Mandatory Certification Standards (*Arjun Panditrao Khotkar v. Kailash Kushanrao Gorantyal, (2020) 7 SCC 1*):
1. **Condition Precedent:** A Section 63 BSA certificate is mandatory to admit secondary electronic records (emails, printouts, chat logs, call detail records, CCTV footage).
2. **Authorized Signatory:** Must be signed by a person occupying an official, responsible position in relation to the management or operation of the relevant computer system or network.
3. **Identification of Media:** Must explicitly identify the source device, hash values (where forensic integrity is relevant), and certify uninterrupted operation.

*I can generate a Section 63 BSA certificate template customized for your client's digital exhibits.*`;
  }

  // 6. Civil Disputes & Injunctions
  if (
    query.includes("cpc") ||
    query.includes("injunction") ||
    query.includes("order 39") ||
    query.includes("commercial suit") ||
    query.includes("specific performance") ||
    query.includes("recovery")
  ) {
    return `### Procedural Framework: Injunctions & Civil Pleadings under CPC, 1908

Under **Order XXXIX, Rules 1 & 2 of the Code of Civil Procedure (CPC), 1908**, grant of a temporary injunction requires satisfying three concurrent tests:

#### The Threefold Injunction Test (*Dalpat Kumar v. Prahlad Singh, (1992) 1 SCC 719*):
1. **Prima Facie Case:** A serious question to be tried with a bona fide probability that the plaintiff is entitled to the relief sought.
2. **Balance of Convenience:** The comparative mischief or inconvenience likely to arise from withholding the injunction is greater than that from granting it.
3. **Irreparable Loss:** The harm suffered cannot be adequately compensated in monetary terms.

#### Commercial Courts Act Mandate:
Under **Section 12A of the Commercial Courts Act, 2015**, pre-institution mediation is mandatory unless the suit contemplates urgent interim relief, which must be specifically pleaded (*Patil Automation v. Rakheja Engineers, (2022)*).

*Would you like me to structure the Application for Temporary Injunction and supporting affidavit?*`;
  }

  // 7. General Legal Consultation Default
  return `### Legal Consultation Brief

Thank you for your inquiry regarding:
> *"${userText.trim().slice(0, 150)}${userText.trim().length > 150 ? "..." : ""}"*

I have analyzed the matter across applicable statutory provisions, procedural rules, and judicial standards.

#### Recommended Next Steps:
1. **Jurisdiction & Forum:** Clarify whether the matter pertains to the District Court, High Court, or a specialized Tribunal (e.g. NCLT, DRT, Consumer Commission).
2. **Factual Matrix:** Outline key dates, relevant agreements, notices, or FIR numbers.
3. **Relief Sought:** Specify whether you require draft pleadings, a statutory legal notice, or comparative case law research.

Please share any case papers or specific details, and I will prepare the relevant pleadings and citations for your chamber.`;
}
