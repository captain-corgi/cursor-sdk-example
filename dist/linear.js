const LINEAR_GRAPHQL = "https://api.linear.app/graphql";
export async function createLinearIssueForReview({ apiKey, teamId, ctx, review, }) {
    const blocking = review.findings.filter((f) => !f.autofixable);
    if (blocking.length === 0)
        return null;
    const title = `PR review findings: ${ctx.prTitle} (#${ctx.prNumber})`;
    const description = buildDescription(ctx, review, blocking);
    const mutation = `
    mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url }
      }
    }
  `;
    const res = await fetch(LINEAR_GRAPHQL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: apiKey,
        },
        body: JSON.stringify({
            query: mutation,
            variables: {
                input: { teamId, title, description },
            },
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Linear HTTP ${res.status}: ${text}`);
    }
    const json = (await res.json());
    if (json.errors && json.errors.length > 0) {
        throw new Error(`Linear GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    const issue = json.data?.issueCreate?.issue;
    if (!json.data?.issueCreate?.success || !issue) {
        throw new Error("Linear issueCreate returned success=false");
    }
    return issue;
}
function buildDescription(ctx, review, blocking) {
    const header = [
        `Automated review findings for ${ctx.prUrl}.`,
        "",
        `**Repository:** ${ctx.owner}/${ctx.repo}`,
        `**Branch:** \`${ctx.headRef}\` -> \`${ctx.baseRef}\``,
        `**Complexity (agent):** ${review.complexity}`,
        "",
        `**Summary:** ${review.summary}`,
        "",
        `## Non-autofixable findings (${blocking.length})`,
        "",
    ].join("\n");
    const items = blocking
        .map((f) => {
        const lineSuffix = f.line !== undefined ? `:${f.line}` : "";
        const fileLink = `[${f.file}${lineSuffix}](${ctx.prUrl}/files)`;
        return `- [ ] **[${f.id}] ${f.title}** (severity: ${f.severity})\n  - File: ${fileLink}\n  - ${f.description}`;
    })
        .join("\n");
    return `${header}${items}\n`;
}
//# sourceMappingURL=linear.js.map