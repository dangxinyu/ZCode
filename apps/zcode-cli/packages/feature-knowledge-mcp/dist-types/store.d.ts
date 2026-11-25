import { type Feature, type FeatureProposal, type FeatureRelationInput, type FeatureVersion, type ProposeInput, type ProposalStatus, type SearchHit } from "@zcode/services/feature-knowledge";
export interface FeatureReadResult {
    feature: Feature;
    versions: FeatureVersion[];
    relations: FeatureRelationInput[];
}
export interface ProposalStatusResult {
    id: string;
    status: ProposalStatus;
    featureId: string | null;
    proposedName: string;
    baseVersion: number | null;
    resolvedAt: number | null;
}
export declare class FeatureKnowledgeMcpStore {
    private readonly dbPath;
    private readDb;
    constructor(dbPath?: string);
    private assertExists;
    private reader;
    search(query: string, limit?: number): SearchHit[];
    read(id: string): FeatureReadResult | null;
    proposalStatus(id: string): ProposalStatusResult | null;
    propose(input: ProposeInput): FeatureProposal;
    close(): void;
}
//# sourceMappingURL=store.d.ts.map