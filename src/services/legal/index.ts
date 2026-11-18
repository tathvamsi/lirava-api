export {
  splitIntoSections,
  parseCpcOrders,
  parseBareAct,
  extractStructuralElements,
  type SectionDraft,
  type ParsedProvision,
  type ParseOptions,
} from "./parser.js";

export {
  type LegalProvisionRow,
  type ProvisionHit,
  ensureLegalProvisionsSchema,
  upsertProvisions,
  seedBuiltInProvisions,
  searchProvisions,
  lookupProvision,
  provisionsDb,
} from "./provisions.js";

export {
  type LegalCaseRow,
  ensureLegalCasesSchema,
  insertLegalCase,
  lookupCaseCitation,
  searchCases,
} from "./cases.js";

export {
  type ConcordanceRow,
  CANONICAL_CONCORDANCE_DATA,
  ensureConcordanceSchema,
  normalizeActCode,
  lookupModernConcordance,
  lookupColonialConcordance,
  getAllConcordanceMappings,
  lookupConcordance,
} from "./concordance.js";

export {
  setQdrant,
  getQdrant,
  type StatutoryQdrantPayload,
  type PrecedentQdrantPayload,
  type LegalCorpusPayload,
  type LegalSearchResult,
  type LegalChunkPoint,
  ensureLegalCorpusCollection,
  searchStatutes,
  upsertLegalChunks,
} from "./qdrant.js";

export {
  type EmbeddingKind,
  generateDeterministicVector,
  embedText,
  embedMany,
  embedBatch,
} from "./embeddings.js";

export {
  type SeedResult,
  pointId,
  getFoundationalProvisions,
  getFoundationalPrecedents,
  LEGAL_FOUNDATIONAL_CORPUS,
  seedProvisionsToPostgres,
  seedCasesToPostgres,
  seedConcordanceToPostgres,
  seedCorpusToQdrant,
  seedLegalCorpus,
} from "./corpus-seeder.js";

export {
  type RetrievedLegalContext,
  retrieveLegalContext,
} from "./rag.js";

export {
  STATUTORY_CORPUS_SEED,
  PRECEDENT_CORPUS_SEED,
  type ParsedPrecedent,
  type LegalSeedDefinition,
  BNSS_PROVISIONS,
  BNS_PROVISIONS,
  BSA_PROVISIONS,
  CPC_PROVISIONS,
  CRPC_PROVISIONS,
  IPC_PROVISIONS,
  ICA_PROVISIONS,
  NIA_PROVISIONS,
  LANDMARK_PRECEDENTS,
} from "./seeds/index.js";
