export type Severity = "low" | "medium" | "high";
export type Complexity = "low" | "medium" | "high";
export type Runtime = "cloud" | "local";

/**
 * Opt-in PR labels that gate each orchestrator step. A PR must carry the
 * matching label for the corresponding step to run; missing `LABELS.REVIEW`
 * makes the whole pipeline a no-op.
 */
export const LABELS = {
  REVIEW: "cursor-review",
  AUTOFIX: "cursor-autofix",
  LINEAR: "cursor-autolinear",
} as const;

export interface Finding {
  id: string;
  file: string;
  line?: number;
  severity: Severity;
  title: string;
  description: string;
  autofixable: boolean;
}

export interface ReviewResult {
  complexity: Complexity;
  summary: string;
  findings: Finding[];
}

export interface RepoContext {
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  repoUrl: string;
  headRef: string;
  baseRef: string;
  labels: string[];
}

export interface AutofixOutcome {
  attempted: boolean;
  fixPrUrl?: string;
  branch?: string;
  error?: string;
}
