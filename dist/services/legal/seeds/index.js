import { BNSS_PROVISIONS } from "./bnss.js";
import { BNS_PROVISIONS } from "./bns.js";
import { BSA_PROVISIONS } from "./bsa.js";
import { CPC_PROVISIONS } from "./cpc.js";
import { CRPC_PROVISIONS } from "./crpc.js";
import { IPC_PROVISIONS } from "./ipc.js";
import { ICA_PROVISIONS } from "./ica.js";
import { NIA_PROVISIONS } from "./nia.js";
import { LANDMARK_PRECEDENTS } from "./precedents.js";
export * from "./types.js";
export { BNSS_PROVISIONS } from "./bnss.js";
export { BNS_PROVISIONS } from "./bns.js";
export { BSA_PROVISIONS } from "./bsa.js";
export { CPC_PROVISIONS } from "./cpc.js";
export { CRPC_PROVISIONS } from "./crpc.js";
export { IPC_PROVISIONS } from "./ipc.js";
export { ICA_PROVISIONS } from "./ica.js";
export { NIA_PROVISIONS } from "./nia.js";
export { LANDMARK_PRECEDENTS } from "./precedents.js";
/**
 * Aggregated statutory corpus containing provisions for all 8 target Bare Acts:
 * BNSS 2023, BNS 2023, BSA 2023, CPC 1908, CrPC 1973, IPC 1860, ICA 1872, NIA 1881.
 */
export const STATUTORY_CORPUS_SEED = [
    ...BNSS_PROVISIONS,
    ...BNS_PROVISIONS,
    ...BSA_PROVISIONS,
    ...CPC_PROVISIONS,
    ...CRPC_PROVISIONS,
    ...IPC_PROVISIONS,
    ...ICA_PROVISIONS,
    ...NIA_PROVISIONS,
];
/**
 * Aggregated landmark judicial precedents covering key Supreme Court authorities.
 */
export const PRECEDENT_CORPUS_SEED = [...LANDMARK_PRECEDENTS];
