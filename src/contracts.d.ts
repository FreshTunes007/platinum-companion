/** Domain IDs are assigned locally; external IDs belong to adapter bindings. */
export type InternalId = string;
export interface Freshness { observedAt: string; sourceSyncedAt: string | null; sourceSyncAgeText: string | null; sourceSyncState: string | null; assessment: 'reported_age' | 'fetch_observed' }
export interface EvidenceSource { kind: string; providerId: string; externalReference: string; url: string | null; freshness: Freshness }
export interface GameSet { id: InternalId; gameKey: string; title: string; platform: string; edition: string | null; gamePatch: string | null; catalogVersion: string | null; mappingStatus: 'external_set_unconfirmed' | 'explicit_binding' }
export interface CatalogTrophy { id: InternalId; setId: InternalId; name: string; groupId: InternalId | null; grade: string | null; hidden: boolean | null }
export interface GroupSummary { id: InternalId; kind: 'base' | 'dlc' | 'unknown'; total: number | null; earned: number | null }
export interface TrophyCatalog { set: GameSet; trophies: CatalogTrophy[]; groups: Omit<GroupSummary, 'earned'>[]; complete: boolean; source: EvidenceSource }
export interface AccountTrophyObservation { id: InternalId; accountId: InternalId; setId: InternalId; trophyId: InternalId; earned: boolean | null; earnedAt: string | null; earnedAtDisplay: string | null; earnedAtTimezone: string | null; observedAt: string; progress: number | null; progressTarget: string | null; source: EvidenceSource }
export interface AccountProgress { accountId: InternalId; setId: InternalId; identityStatus: 'user_supplied_profile' | 'authenticated_account'; observations: AccountTrophyObservation[]; summary: {total: number; earned: number; groups: GroupSummary[]}; complete: boolean; source: EvidenceSource }
export interface SyncStatus { providerId: string; state: 'snapshot_available' | 'not_connected' | 'connected' | 'ready' | 'degraded' | 'blocked_external_auth'; automatic: boolean; lastSuccessfulFetchAt: string | null; sourceSyncedAt: string | null; sourceSyncAgeText: string | null; error: string | null }
export interface TrophyProvider {
  getGameSets(): Promise<GameSet[]>;
  getTrophies(setId: InternalId): Promise<TrophyCatalog>;
  getAccountProgress(accountId: InternalId, setId: InternalId): Promise<AccountProgress>;
  getSyncStatus(): SyncStatus;
}
// Canonical pack trophy keys are resolved to internal IDs in a reviewed binding.
// Missing bindings are UNKNOWN, including when a provider returns complete=true.
export interface TrophyMapping { [canonicalTrophyKey: string]: InternalId | null }
export interface RunFact { value: unknown; source: 'user_confirmation' | 'synthetic_test' | 'evidence'; observedAt: string; revision: number; runId?: InternalId; field?: string; reportedAnswer?: string; revisionDelta?: {from: number; to: number} }
export interface ProgressEvent { id: string; type: 'ProgressEvent'; dataKind: 'user_state'; source: 'user_confirmation'; runId: InternalId; observedAt: string; userFacingWording: string[]; revision: number; revisionDelta: {from: number; to: number}; changes: (RunFact & {field: string; previous: RunFact | null})[] }
export interface FactConflict { fact: string; confirmed: RunFact; incoming: RunFact; status: 'needs_reconciliation' }
export interface PlayerState { dataKind: 'synthetic_test' | 'user_state'; stateRevision: number; activeRun: {id: InternalId; gameSetId: InternalId; dataKind: 'synthetic_test' | 'user_state'}; facts: Record<string, RunFact>; conflicts: FactConflict[] }
export type RequirementLevel = 'MUST' | 'RECOMMENDED' | 'OPTIONAL';
export type GameRecommendationCategory = RequirementLevel | 'TIP';
export interface CoachEvidence { source: string; reference: string; verificationStatus: string; limitation?: string }
export interface CoachTip { id: string; category: 'TIP'; message: string; whyNow: string; evidence: CoachEvidence[] }
export interface ContextualCoach { mode: 'contextual_coach_v0'; tips: CoachTip[]; limit: 2 }
export interface CompanionPreferences { playBlockMinutes: number; detailedRoute: boolean; tipLimit: 2; updateCadence: 'session_end_or_major_milestone_or_critical_choice'; source: 'user_confirmation'; observedAt: string; revision: number }
export interface StateUpdateRequest { id: string; category: 'UPDATE_NEEDED'; fact: string; message: string; whyNow: unknown; trigger: string; status: 'ready' | 'waiting_for_gameplay_event'; answerValues?: unknown[] }
export type VersionVerificationStatus = 'VERIFIED_FOR_CURRENT_VERSION' | 'SUPPORTED_FOR_CURRENT_VERSION' | 'VERSION_UNCERTAIN' | 'DISPUTED';
export interface TrophyImplication { implicationId: string; trophyKey: string; condition: unknown; expectedStatus: 'EXPECTED_FROM_GAME_STATE'; verificationStatus: string; evidence: unknown[] }
export interface TrophyExpectation { trophyKey: string; trophyId: InternalId | null; runId: InternalId; expectationSource: 'game_state' | 'user_report'; status: 'EXPECTED_FROM_GAME_STATE' | 'REPORTED_BY_USER' | 'CONFIRMED_BY_PROVIDER'; providerConfirmed: boolean; providerEarned: boolean | null; earnedAt: string | null; providerObservedAt: string | null; reconciliation: 'MATCH' | 'UNKNOWN_MAPPING' | 'PROVIDER_LAG_OR_UNCERTAINTY' | 'NEEDS_RECONCILIATION'; providerRunAssociation: 'unknown' }
export type TrophyRefreshCategory = 'major_story_milestone' | 'linked_boss_or_quest_completion' | 'chapter_or_region_transition' | 'user_reports_trophy_earned' | 'session_end' | 'explicit_manual_refresh';
export interface TrophyRefreshTrigger { category: TrophyRefreshCategory; eventId: string; requestedAt: string }
export interface TrophySyncRequestState { pending: TrophyRefreshTrigger[]; status: string; lastAttemptAt: string | null; lastSuccessAt: string | null; nextEligibleAt: string | null; autoRefreshEnabled?: boolean; error?: string | null }
export interface RoadmapRecommendation { ruleId: string; title: string; status: string; actionable: boolean; safeToDefer: boolean; requirementLevel: RequirementLevel; purpose: string; trophyCondition: boolean; objectiveRequirementLevel: RequirementLevel; currentVersionStatus: VersionVerificationStatus | null; verificationStatus: 'CONFIRMED' | 'SUPPORTED' | 'UNVERIFIED' | 'DISPUTED'; message: string; explanation: {ruleId: string; playerFacts: RunFact[]; accountTrophyFacts: unknown[]; evidenceStatus: string; evidence: unknown[]; category: string; reason: string; versionCoverage: string} }
export interface Roadmap { mode: 'roadmap_v0'; doNow: RoadmapRecommendation[]; beforeProgressing: RoadmapRecommendation[]; canDefer: RoadmapRecommendation[]; blockedOrLost: RoadmapRecommendation[]; criticalUnknowns: unknown[]; questions: unknown[]; nextSteps: unknown[]; coach: ContextualCoach; updateRequests: StateUpdateRequest[]; evidenceCoverage: unknown; stateRevision: number; knowledgePackVersion: string }
