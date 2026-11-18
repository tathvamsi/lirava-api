"""Case files S3 (cheque dishonour) and S4 (SC/ST Act). Everything is invented. See build_casefiles.py."""

S3_CHEQUE = """# CHEQUE AND DEPOSIT RECORD

## Cheque (description of the instrument)
Cheque no. 552318. Drawn on: Southern Commercial Bank, T. Nagar branch, Chennai. Date: 28 January 2026. Payee: Sunrise Agro Traders. Amount: Rs. 7,25,000 (Rupees seven lakh twenty-five thousand only). Drawer: Coastal Foods Pvt. Ltd., by its Managing Director Mr. R. Venkatesh (signature). The cheque is marked "Account payee".

## Deposit slip
Hubballi Urban Co-operative Bank, Keshwapur branch, Hubballi. Pay-in slip dated 3 February 2026 for credit to the current account of Sunrise Agro Traders (account no. ending 7203). Cheque no. 552318 for Rs. 7,25,000 handed over for collection through clearing. Slip receipt stamped by the branch on 3 February 2026 at 11:42.
"""

S3_INVOICES = """# TAX INVOICES AND LEDGER

Sunrise Agro Traders, Keshwapur, Hubballi (proprietor: Mr. Anand Kulkarni). Customer: Coastal Foods Pvt. Ltd., T. Nagar, Chennai.

Invoice SAT/2025/118 dated 10 December 2025: cold-pressed groundnut oil, 3,000 kg at Rs. 168 per kg ........ Rs. 5,04,000
Invoice SAT/2025/131 dated 24 December 2025: jaggery blocks, 2,500 kg at Rs. 56 per kg ........................ Rs. 1,40,000
Invoice SAT/2026/004 dated 15 January 2026: cold-pressed groundnut oil, 500 kg at Rs. 162 per kg ............ Rs. 81,000
Total invoiced ..................................................................................... Rs. 7,25,000

## Ledger of Coastal Foods Pvt. Ltd.
Opening balance 1 December 2025: nil. Debits: Rs. 7,25,000 (three invoices above). Credits: nil. Balance outstanding on 31 January 2026: Rs. 7,25,000 (before the cheque was banked). The cheque for the full amount was received on 28 January 2026.

Terms printed on each invoice: payment within 30 days; goods once sold are not returnable except for proven damage in transit reported in writing within 3 days of delivery. Interest at 18 per cent a year on overdue amounts.
"""

S3_EMAILS = """# EMAIL CORRESPONDENCE BETWEEN THE PARTIES

From: R. Venkatesh <purchase@coastalfoods.example>  To: Anand Kulkarni      Date: 20 January 2026, 16:22
Subject: Invoice SAT/2025/118
We are checking the lot of oil received on 14 December. A few of our customers have complained about the smell in some drums. Please send someone to look at the stock at Chennai. We will clear the payment after this is settled.

From: Anand Kulkarni  To: R. Venkatesh      Date: 21 January 2026, 10:05
We delivered 3,000 kg of oil in sealed drums with a quality report dated 9 December 2025. No complaint was made within 3 days as per the terms. Please clear the dues of Rs. 7,25,000 by 31 January.

From: R. Venkatesh  To: Anand Kulkarni      Date: 27 January 2026, 18:10
I will send a cheque for the full amount tomorrow so that you are not inconvenienced. Please do not make the complaint about the oil quality a problem. We will settle any difference later.

From: Anand Kulkarni  To: R. Venkatesh      Date: 28 January 2026, 20:15
Cheque no. 552318 received by courier today. Thank you. We will present it after 1 February.
"""

S3_RETURN_MEMO = """# CHEQUE RETURN MEMO

Hubballi Urban Co-operative Bank, Keshwapur branch, Hubballi.
To: Sunrise Agro Traders, current account ending 7203.                              Date: 5 February 2026

We regret to inform you that the cheque described below, deposited by you for collection on 3 February 2026, has been returned unpaid by the drawee bank.

Cheque no.: 552318          Date of cheque: 28 January 2026          Amount: Rs. 7,25,000
Drawer: Coastal Foods Pvt. Ltd.        Drawee bank: Southern Commercial Bank, T. Nagar branch, Chennai
Date of return by the drawee bank: 5 February 2026        Return reason code and remark: 51 - "FUNDS INSUFFICIENT"
Return charges debited: Rs. 295.

The memo was handed to the payee's representative on 6 February 2026 at 12:10 and acknowledged by signature.
Branch Manager
"""

S3_NOTICE = """# LEGAL NOTICE

S. Patil, Advocate, Station Road, Hubballi.         Date: 20 February 2026
By Registered Post A.D. and by email

To: Coastal Foods Pvt. Ltd., T. Nagar, Chennai, through its Managing Director Mr. R. Venkatesh; and to Mr. R. Venkatesh personally.

Under instructions from my client Sunrise Agro Traders, Keshwapur, Hubballi (proprietor Mr. Anand Kulkarni), I give you notice as follows.

1. My client supplied you cold-pressed groundnut oil and jaggery under invoices dated 10 December 2025, 24 December 2025 and 15 January 2026 for a total of Rs. 7,25,000.
2. In discharge of that liability you issued cheque no. 552318 dated 28 January 2026 for Rs. 7,25,000 drawn on Southern Commercial Bank, T. Nagar branch, Chennai. My client presented the cheque for collection through its account at Hubballi Urban Co-operative Bank, Keshwapur branch, on 3 February 2026. It was returned unpaid on 5 February 2026 with the remark "Funds insufficient". The return memo reached my client on 6 February 2026.
3. You are called upon to pay Rs. 7,25,000 within fifteen days of receipt of this notice, failing which my client will prosecute you under Section 138 of the Negotiable Instruments Act, 1881 and take all other remedies, at your cost.

S. Patil, Advocate for Sunrise Agro Traders
"""

S3_POSTAL = """# POSTAL ACKNOWLEDGEMENT AND TRACKING

Registered Post A.D. article no. RW 4481 2203 7 IN, booked at Hubballi Head Post Office on 20 February 2026 at 15:40, addressed to Coastal Foods Pvt. Ltd., T. Nagar, Chennai.
Tracking: 20 Feb 2026 booked - 21 Feb 2026 despatched - 22 Feb 2026 reached Chennai Mount Road - 23 Feb 2026 11:20 delivered to office reception.
Acknowledgement card (A.D.): received by "Reception, Coastal Foods", signature illegible, dated 23 February 2026. Return of the card to the sender: 27 February 2026.

Email copy of the notice was sent to purchase@coastalfoods.example on 20 February 2026 at 16:05; the server shows it as delivered. No reply was received to either.
"""

S3_BANK_CERT = """# CERTIFICATE OF THE PAYEE'S BANK

Hubballi Urban Co-operative Bank, Keshwapur branch, Hubballi.                Date: 2 April 2026
This is to certify that Sunrise Agro Traders, Keshwapur, Hubballi, maintains a current account no. ending 7203 at this branch since 14 June 2018, and that cheque no. 552318 dated 28 January 2026 for Rs. 7,25,000 drawn by Coastal Foods Pvt. Ltd. on Southern Commercial Bank, T. Nagar branch, Chennai, was delivered at this branch on 3 February 2026 for collection through the said account. The cheque was sent for clearing through the clearing house and returned unpaid on 5 February 2026.
Branch Manager
"""

S3_MCA = """# COMPANY INFORMATION (EXTRACT)

Coastal Foods Pvt. Ltd. Registered office: T. Nagar, Chennai. Incorporated 2016. Status: active.
Directors: (1) Mr. R. Venkatesh, Managing Director, DIN ending 2841, appointed 2016, authorised signatory for bank accounts and cheques; (2) Ms. Priya Narayanan, Director (non-executive), appointed 12 March 2024, no executive role stated in the company's records; (3) Mr. Gopal Menon, Director, resigned on 30 June 2025.
Authorised signatories for cheques: Mr. R. Venkatesh singly, as per bank mandate.
Charges registered: one charge in favour of a bank for working capital.
"""

S3_COMPLAINT = """# COMPLAINT UNDER SECTION 138 READ WITH SECTION 142 OF THE NEGOTIABLE INSTRUMENTS ACT, 1881
## C.C. No. 233/2026, JMFC Court, Hubballi

Complainant: Sunrise Agro Traders, represented by its proprietor Mr. Anand Kulkarni, Keshwapur, Hubballi. Accused: (1) Coastal Foods Pvt. Ltd., T. Nagar, Chennai; (2) Mr. R. Venkatesh, Managing Director.        Filed on 4 April 2026.

The complaint states the facts at paragraphs 1 to 7: supply of goods against three invoices; issue of cheque no. 552318 dated 28 January 2026 for Rs. 7,25,000; presentation on 3 February 2026 through the complainant's account at Keshwapur branch, Hubballi; return on 5 February 2026 "funds insufficient"; notice dated 20 February 2026 delivered on 23 February 2026; no payment within 15 days; cause of action arising on 11 March 2026 and the complaint being filed within one month.

Paragraph 8: The Hon'ble Court has territorial jurisdiction because the cheque was delivered for collection through the complainant's account at Keshwapur branch, Hubballi, within the local limits of this Court.
Paragraph 9: The second accused was in charge of and responsible for the conduct of the business of the first accused at the time of the offence and is its signatory (Section 141).
The complainant has filed an affidavit in lieu of examination in chief under Section 145 of the Act, with the documents marked Ex. P-1 to P-9.
"""

S3_ORDER_SHEET = """# ORDER SHEET - C.C. No. 233/2026 (JMFC COURT, HUBBALLI)

4 April 2026: Complaint presented with affidavit and documents. Registered. Verification of the complainant recorded.
20 April 2026: Cognizance taken of the offence under Section 138 of the Negotiable Instruments Act. Summons to accused 1 and 2, returnable on 8 June 2026.
8 June 2026: Summons served on accused 1 by registered post, accused 2 present with counsel Mr. T. Ramesh; time sought for appearance of accused 1. Accused 2 granted bail on bond of Rs. 10,000.
22 July 2026: Both accused present. Substance of the accusation read; plea recorded: not guilty. The accused wish to cross-examine the complainant. Complainant's affidavit evidence accepted as evidence in chief under Section 145.
2 November 2026: Accused filed an application (I.A. No. 4) challenging territorial jurisdiction. Objections invited. List for hearing on 15 December 2026.
"""

S3_APPLICATION = """# I.A. No. 4 IN C.C. No. 233/2026
## Application challenging territorial jurisdiction

Filed on 2 November 2026 on behalf of accused nos. 1 and 2.

1. The accused submit that this Hon'ble Court has no territorial jurisdiction to try the complaint. The cheque in question is drawn on the T. Nagar branch of Southern Commercial Bank at Chennai, which is the drawee bank, and the cheque was dishonoured there.
2. The Hon'ble Supreme Court held in Dashrath Rupsingh Rathod v. State of Maharashtra that the offence under Section 138 is completed only at the place where the cheque is dishonoured, being the situs of the drawee bank, and that the court at that place alone has jurisdiction.
3. The complaint should therefore be returned to be presented before the competent Court at Chennai.
4. The accused further submit that the goods supplied were of inferior quality, that there is a dispute between the parties, and that the cheque was issued only as security. These are matters for trial.

Prayer: that the complaint be returned for presentation before the competent court at Chennai.
(Mr. T. Ramesh, Advocate for the accused)
"""

S3_GUIDE = """# TESTER GUIDE - S3: Cheque dishonour (do not upload this file)

**Client:** Sunrise Agro Traders (complainant), Hubballi. **Court:** JMFC Court, Hubballi. Hearing on the jurisdiction application: 15 Dec 2026.
**Documents:** 01 cheque and deposit slip, 02 invoices and ledger, 03 emails, 04 return memo (scan), 05 legal notice, 06 postal acknowledgement, 07 payee's bank certificate, 08 company details, 09 complaint, 10 order sheet, 11 accused's jurisdiction application.

## Things to ask
1. Was the complaint filed in time? (Dishonour 5 Feb; memo received 6 Feb; notice 20 Feb is within 30 days; delivered 23 Feb; 15 days to pay ended 10 Mar; cause of action 11 Mar; complaint due by 10 Apr; filed 4 Apr. In time.)
2. Is the accused right that only a Chennai court has jurisdiction, citing Dashrath Rupsingh Rathod? (No. Section 142(2) of the Act, as amended in 2015, gives jurisdiction to the court where the payee's account branch is, here Keshwapur, Hubballi. The bank certificate proves delivery for collection there. Dashrath Rupsingh Rathod was decided before the amendment.)
3. What presumptions help us and how can the accused rebut them? (Sections 118(a) and 139: the cheque is presumed issued for a debt; the accused must rebut on the balance of probabilities. Here the emails show a quality complaint made after the 3-day window, and the accused wrote "I will send a cheque for the full amount".)
4. Is the director personally liable? (Section 141: Mr. Venkatesh is the MD and signatory. Ms. Priya Narayanan, who is not in the complaint, was not in charge of the business.)
5. Does the quality dispute defeat the case? (A disputed debt can be a defence but is a matter for evidence; the cheque was for the full sum, after the complaint.)
6. Draft our reply to the jurisdiction application. (It should ask the language first.)

## Right answers and traps
- Dashrath Rupsingh Rathod (2014) is superseded on this point by the 2015 amendment inserting Section 142(2). A platform that agrees with the accused is wrong.
- The notice must be given within 30 days of the information of dishonour, the drawer has 15 days to pay, and the complaint is due within one month of the cause of action (Section 142(1)(b), with a power to condone delay).
- "Security cheque" is a defence argument that needs evidence.

## Good authority (from the library)
- Dashrath Rupsingh Rathod v. State of Maharashtra: 2014 INSC 514, [2014] 11 S.C.R. 921 (cited here to test whether the platform notes that it was changed by the amendment).
"""

# ---------------------------------------------------------------------------------------------------------- S4

S4_FIR = """# FIRST INFORMATION REPORT
## (Under Section 173 of the Bharatiya Nagarik Suraksha Sanhita, 2023)

District: Tumakuru      Police Station: Kunigal      FIR No.: 77/2026
Date and time of report: 9 October 2026, 15:30 hours
Acts and sections: Section 3(1)(r) and 3(1)(s) of the Scheduled Castes and the Scheduled Tribes (Prevention of Atrocities) Act, 1989

Date and time of occurrence: 7 October 2026, about 11:00 hours
Place: Open yard in front of the Gram Panchayat office, Hulikal village, Kunigal Taluk
Complainant: Mr. Rajanna Madar, aged 44, agricultural labourer, Hulikal village, belonging to the Adi Karnataka community (Scheduled Caste)
Accused: Mr. Basavaraj Gowda, aged 58, farmer, member of the Gram Panchayat, Hulikal village

## Particulars
On 7 October 2026 a Gram Panchayat meeting was held in the open yard of the panchayat office to read out the list of site allotments under the housing scheme. About sixty villagers were present. When my brother's name was not found in the list I asked the Panchayat Development Officer why. Basavaraj Gowda, a panchayat member, shouted at me in front of everyone, abused me by my caste name and said that people of my caste have no right to sit in the front row and should sit on the ground at the back. Many villagers heard it. I felt greatly humiliated. I did not complain on that day because I was frightened. I have now gone to the police station on 9 October at the advice of friends. Witnesses: Chandru and Gangamma, who were present.

Case registered. Investigation by the Deputy Superintendent of Police, Kunigal Sub-Division.
"""

S4_COMPLAINANT = """# STATEMENT OF COMPLAINANT
## Recorded under Section 180 of the Bharatiya Nagarik Suraksha Sanhita, 2023

Kunigal Police Station, Crime No. 77/2026.     Date: 10 October 2026.     Recorded by: Sri P. Narasimha, Deputy Superintendent of Police.

Witness: Rajanna Madar, aged 44, son of Late Madaiah, agricultural labourer, Hulikal village.

I belong to the Adi Karnataka community which is a Scheduled Caste. I have a caste certificate. On 7 October at about 11 am the Gram Panchayat meeting was held in the yard. About sixty people were present. The list for the housing scheme was read and my brother Ramesh's name was not there. I asked the PDO why. Basavaraj Gowda stood up and said in a loud voice, in front of everyone, using my caste name as an abuse, and said that people like me should not sit in front and should go to the back. I told him not to abuse me. He said it again. Chandru and Gangamma were standing near me. Many others heard. I went home. I did not go to the police on that day because I was afraid of him; he is an influential man in our village. After talking to a relative, I went to the police on 9 October.

I have a mobile video of the meeting made by my nephew Suresh, in which the shouting can be heard. I will hand it over.
"""

S4_WITNESS_CHANDRU = """# STATEMENT OF WITNESS
## Recorded under Section 180 of the Bharatiya Nagarik Suraksha Sanhita, 2023

Kunigal Police Station, Crime No. 77/2026.     Date: 11 October 2026.     Recorded by: Sri P. Narasimha, Deputy Superintendent of Police.

Witness: Chandru, aged 36, farmer, Hulikal village.

I was present at the panchayat meeting on 7 October in the yard. Rajanna Madar asked why his brother's name was not in the site list. Basavaraj Gowda got angry and said in a loud voice abusing Rajanna by his caste name. He said such people should sit at the back. I heard it clearly as I was standing about five feet from them. Many people heard. After that the meeting was stopped for some time and the PDO asked everyone to sit down. I know both of them well and I have no enmity with Basavaraj Gowda.
"""

S4_WITNESS_GANGAMMA = """# STATEMENT OF WITNESS
## Recorded under Section 180 of the Bharatiya Nagarik Suraksha Sanhita, 2023

Kunigal Police Station, Crime No. 77/2026.     Date: 11 October 2026.     Recorded by: Sri P. Narasimha, Deputy Superintendent of Police.

Witness: Gangamma, aged 52, wife of Siddappa, agricultural worker, Hulikal village.

I was in the meeting on 7 October, sitting near the women's side. There was a quarrel about the site list. Both Rajanna and Basavaraj were shouting. There was a lot of noise because many people were speaking at the same time. I heard harsh words. I cannot say what exact words were said by whom as I was sitting some distance away and I am a little hard of hearing. After some time the PDO asked everyone to be quiet. I do not know about any caste abuse. The police told me to say what I heard; I have said what I know.
"""

S4_MINUTES = """# MINUTES OF THE GRAM PANCHAYAT MEETING

Hulikal Gram Panchayat, Kunigal Taluk, Tumakuru District.          Meeting held on 7 October 2026, 10:30 to 12:10, in the open yard of the panchayat office.
Chaired by: President Smt. Lakshmi Bai. Present: 11 of 13 members; 58 villagers (attendance register attached). Secretary: Panchayat Development Officer, Sri K. Mahesh.

Item 1: Reading of the draft list of 24 beneficiaries for house sites under the housing scheme. Several villagers objected that the list had been prepared without a survey. Sri Rajanna Madar, a villager, stated that his brother's name had been omitted. Sri Basavaraj Gowda, member, replied that the list had been prepared on the basis of income and land records and that Sri Ramesh Madar's name had been dropped because he already owns a house site. There was a heated exchange between them. The President asked both to sit down. The meeting was adjourned for 10 minutes at 11:25 and resumed.
Item 2: It was resolved to appoint a committee of three members to verify the list within 15 days.
Item 3: Next meeting on 5 November 2026.

The minutes record no use of caste names. Signed by the President and the Secretary on 7 October 2026.
Note: the minutes were written by the Secretary from his notes after the meeting.
"""

S4_SITE_LIST = """# DRAFT LIST OF BENEFICIARIES - HOUSE SITES (EXTRACT) AND REPRESENTATION

Hulikal Gram Panchayat. Draft list dated 5 October 2026: 24 names. Sri Ramesh Madar, son of Late Madaiah, is not in the list.
Representation dated 6 October 2026 by Sri Ramesh Madar to the President: he states that he lives with his wife and four children in a rented house, has no site, that he belongs to a Scheduled Caste and has applied under the scheme in 2024, and that his name was dropped without reasons. No reply is recorded.
Office note of the PDO dated 6 October 2026: Sri Ramesh Madar has a registered house site at Hulikal (Survey no. 118) in his mother's name according to land records; the beneficiary committee dropped him on this ground. The mother, Late Madaiah's widow, is aged 76.
The members who recommended the dropping of the name include Sri Basavaraj Gowda.
"""

S4_CASTE_CERT = """# CASTE CERTIFICATE

Office of the Tahsildar, Kunigal Taluk, Tumakuru District.            Certificate no. TAL/KGL/SC/2019/4417 dated 11 March 2019.
This is to certify that Sri Rajanna Madar, son of Late Madaiah, resident of Hulikal village, Kunigal Taluk, belongs to the Adi Karnataka community, which is recognised as a Scheduled Caste under the Constitution (Scheduled Castes) Order, 1950, as amended. This certificate is issued on the basis of the school records and the enquiry report of the Revenue Inspector.
Validity: valid for use in the State. Tahsildar, Kunigal.
"""

S4_VIDEO = """# NOTE ON MOBILE VIDEO AND TRANSCRIPT

Kunigal Police Station, Crime No. 77/2026.     Date: 12 October 2026.
Item: a mobile video of the Gram Panchayat meeting held on 7 October 2026, duration 4 minutes 52 seconds, recorded by Suresh (nephew of the complainant) on his Android phone and copied on to a pen drive handed over to the police by the complainant on 10 October 2026. The original phone has not been seized. The file name is "VID_20261007_1108.mp4".

## Transcript prepared by the police (partial; translated from Kannada)
00:41 Voice 1: Why is my brother's name not in the list? 00:47 Voice 2: Sit down. It was done by the committee. 01:03 Voices overlap, not clear. 01:15 Voice 2 (loud, partly unclear): ... you people ... sit behind ... 01:19 Voice 1: Don't abuse me. 01:22 Several voices. 02:10 PDO: Everybody please sit down.
Note by the Investigating Officer: the exact word spoken at 01:15 is not clear from the recording and is being sent for voice and audio clarity examination. No certificate under Section 63 of the Bharatiya Sakshya Adhiniyam, 2023 has been obtained from the person who made the video or from the owner of the device. The faces of three persons are visible.
"""

S4_NOTICE = """# NOTICE UNDER SECTION 35(3) OF THE BHARATIYA NAGARIK SURAKSHA SANHITA, 2023

Kunigal Police Station, Crime No. 77/2026.           Date: 12 November 2026
To: Sri Basavaraj Gowda, Hulikal village.
A case has been registered against you under Section 3(1)(r) and 3(1)(s) of the Scheduled Castes and the Scheduled Tribes (Prevention of Atrocities) Act, 1989. You are directed to appear before the Deputy Superintendent of Police, Kunigal Sub-Division, on 20 November 2026 at 11:00 hours at Kunigal Police Station for questioning and to produce any document or recording relating to the panchayat meeting of 7 October 2026. If you do not comply, you may be arrested.
Deputy Superintendent of Police, Kunigal.
Acknowledged by Basavaraj Gowda on 12 November 2026.
"""

S4_CLIENT = """# CLIENT INSTRUCTION SHEET (PRIVILEGED AND CONFIDENTIAL)

Client: Basavaraj Gowda, aged 58, farmer with 6 acres, elected member of the Hulikal Gram Panchayat since 2021. Wife Parvathamma, two sons (one an engineer in Bengaluru). No previous case. He has diabetes and hypertension.

His account: At the meeting there was a quarrel about the site list; Rajanna Madar kept shouting and accused him of favouring his own people. He lost his temper and said "you people always make trouble", meaning troublemakers. He says he did not use any caste name and does not know the caste of every villager. He did say, "Go and sit at the back and be quiet", because people were pushing forward. The committee dropped Ramesh Madar's name because he owns a site in his mother's name. He thinks the case was filed to put pressure after the list was published. He has a good name in the village and the President and the PDO will say so.

He asked: can he be arrested immediately? Should he go on 20 November? Can he file for anticipatory bail?
"""

S4_GUIDE = """# TESTER GUIDE - S4: Caste abuse at a panchayat meeting (do not upload this file)

**Client:** Basavaraj Gowda (accused, no arrest yet; police notice to appear on 20 Nov 2026). **Forum:** Special Court under the SC/ST Act, Tumakuru, and the High Court.
**Documents:** 01 FIR, 02 complainant's statement, 03 and 04 witness statements, 05 panchayat minutes, 06 site list and representation, 07 caste certificate, 08 video note, 09 police notice, 10 client instructions (privileged).

## Things to ask
1. Which offences are alleged and what is the punishment? (SC/ST Act 3(1)(r): intentional insult or intimidation with intent to humiliate in any place within public view; 3(1)(s): abuse by caste name in any place within public view. Imprisonment not less than six months, up to five years, with fine.)
2. Can we simply file for anticipatory bail under Section 482 BNSS? (Section 18 of the SC/ST Act, repeated in 18A(2), says section 438 of the Code, now BNSS 482, does not apply to cases under this Act. The platform must flag the bar first. The courts have recognised a narrow exception where, on the face of the complaint, no offence under the Act is made out; the platform should say this carefully and not assume it applies.)
3. Does the Subhash Kashinath Mahajan judgment protect him from arrest? (Not on its own: Section 18A (2018) says no preliminary enquiry and no approval for arrest is needed, notwithstanding any judgment.)
4. What are the weaknesses in the prosecution case? (Delay of 2 days in the FIR, explained as fear. One witness (Gangamma) does not support the caste abuse. The video does not clearly record the caste word, the original phone was not seized, and there is no Section 63 BSA certificate, so the electronic record may not be admissible as it stands. The minutes record no caste abuse but were written afterwards by the Secretary. The "public view" requirement is probably met, as it was an open yard with about 60 people. Motive: a dispute over the site list. Counter: Ramesh Madar owns a site in his mother's name.)
5. Should he appear on 20 November? (A notice under BNSS 35(3) should be complied with; he should go, with a lawyer's advice, and the platform should say so.)
6. What is the importance of the video? What must be done to use it? (Seizure of the original device and a certificate under Section 63 of the Bharatiya Sakshya Adhiniyam, 2023; clarity examination.)

## Right answers and traps
- Do not let the platform tell you anticipatory bail is simply available.
- "Public view" needs a place where members of the public can see or hear, not merely a private place.
- The platform should not treat the client's private account (document 10) as an admission to be disclosed.
- Check whether it cites SC/ST sections as 3(1)(r) and 3(1)(s) and not as IPC sections.

## Good authority (from the library)
- Dr. Subhash Kashinath Mahajan v. State of Maharashtra: 2018 INSC 248, [2018] 4 S.C.R. 877 (safeguards that were later overtaken by Section 18A; the platform should say so).
"""

CASES_B = [
    {
        "folder": "S3-Cheque-dishonour-Sunrise-Agro",
        "docs": [
            {"file": "01-Cheque-and-deposit-slip.pdf", "kind": "pdf", "body": S3_CHEQUE},
            {"file": "02-Invoices-and-ledger.pdf", "kind": "pdf", "body": S3_INVOICES},
            {"file": "03-Email-correspondence.pdf", "kind": "pdf", "body": S3_EMAILS},
            {"file": "04-Cheque-return-memo-scanned.pdf", "kind": "scan", "body": S3_RETURN_MEMO},
            {"file": "05-Legal-notice-20Feb2026.pdf", "kind": "pdf", "body": S3_NOTICE},
            {"file": "06-Postal-acknowledgement-and-tracking.pdf", "kind": "pdf", "body": S3_POSTAL},
            {"file": "07-Payee-bank-certificate.pdf", "kind": "pdf", "body": S3_BANK_CERT},
            {"file": "08-Company-details-Coastal-Foods.pdf", "kind": "pdf", "body": S3_MCA},
            {"file": "09-Complaint-CC-233-2026.pdf", "kind": "pdf", "body": S3_COMPLAINT},
            {"file": "10-Order-sheet.pdf", "kind": "pdf", "body": S3_ORDER_SHEET},
            {"file": "11-Accused-application-jurisdiction-IA-4.pdf", "kind": "pdf", "body": S3_APPLICATION},
        ],
        "guide": S3_GUIDE,
    },
    {
        "folder": "S4-SC-ST-Act-Basavaraj-Gowda",
        "docs": [
            {"file": "01-FIR-77-2026.pdf", "kind": "pdf", "body": S4_FIR},
            {"file": "02-Statement-of-complainant-Rajanna-Madar.pdf", "kind": "pdf", "body": S4_COMPLAINANT},
            {"file": "03-Statement-of-witness-Chandru.pdf", "kind": "pdf", "body": S4_WITNESS_CHANDRU},
            {"file": "04-Statement-of-witness-Gangamma.pdf", "kind": "pdf", "body": S4_WITNESS_GANGAMMA},
            {"file": "05-Panchayat-meeting-minutes.pdf", "kind": "pdf", "body": S4_MINUTES},
            {"file": "06-Site-list-and-representation.pdf", "kind": "pdf", "body": S4_SITE_LIST},
            {"file": "07-Caste-certificate.pdf", "kind": "pdf", "body": S4_CASTE_CERT},
            {"file": "08-Video-note-and-transcript.pdf", "kind": "pdf", "body": S4_VIDEO},
            {"file": "09-Police-notice-35-3-BNSS.pdf", "kind": "pdf", "body": S4_NOTICE},
            {"file": "10-Client-instruction-sheet-PRIVILEGED.docx", "kind": "docx", "body": S4_CLIENT},
        ],
        "guide": S4_GUIDE,
    },
]
