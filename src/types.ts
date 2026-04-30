export type Severity = "low" | "medium" | "high";
export type Complexity = "low" | "medium" | "high";
export type Runtime = "cloud" | "local";

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
}

export interface AutofixOutcome {
  attempted: boolean;
  fixPrUrl?: string;
  branch?: string;
  error?: string;
}
