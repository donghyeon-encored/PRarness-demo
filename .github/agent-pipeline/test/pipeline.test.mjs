import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  GitHubClient,
  PipelineError,
  authorizeProtectedPaths,
  branchName,
  buildCodegraph,
  checkProtectedPaths,
  createPatch,
  evaluateAllOk,
  evaluateChangeScope,
  evaluateRisk,
  findStateComment,
  gateEvent,
  globToRegExp,
  initialState,
  loadState,
  loadTeam,
  matchesGlob,
  normalizeAgentOutput,
  parseProtectedApprovalCommand,
  parseProtectedRequest,
  parseStateComment,
  parseYaml,
  pathsFromNul,
  planFromReview,
  publish,
  reconcilePlan,
  renderPullRequestBody,
  renderProgress,
  routeAgent,
  selectOwner,
  selectPrTeam,
  validateLivePublication,
} from "../pipeline.mjs";

const team = {
  version: 1,
  pipeline: {
    bootstrap_agent: "codex",
    fallback_assignee: "platform-maintainer",
    max_pr_assignees: 3,
    max_auto_iterations: 5,
    branch_prefix: "agent/issue-",
    unknown_risk_is_high: true,
    change_scope: {
      commit_unit: "single_crud_bundle",
      pr_unit: "single_semantic_unit",
      target_pr_changed_lines: 200,
      max_pr_changed_lines: 400,
    },
    risk_policy: {
      equivalent_severity_is_high: true,
      categories: [
        ["access_control", "authorization", "authorization bypass"],
        ["sensitive_information_exposure", "credential", "credential exposure"],
        ["application_security", "injection", "remote code execution"],
        ["security_configuration", "encryption", "certificate validation disabled"],
        ["data_integrity", "consistency", "data corruption"],
        ["data_loss", "delete", "irreversible deletion"],
        ["data_compatibility", "schema", "breaking schema"],
        ["data_governance", "retention", "retention violation"],
        ["service_availability", "availability", "service outage"],
        ["performance_capacity", "resource consumption", "capacity exhaustion"],
        ["dependency_resilience", "dependency", "retry storm"],
        ["deployment_recovery", "rollback", "rollback impossible"],
        ["operational_visibility", "observability", "observability blind spot"],
      ].map(([id, signal, highImpact]) => ({ id, signals: [signal], high_impact_signals: [highImpact] })),
    },
    protected_paths: [".github/workflows/**", ".github/agent-pipeline/**", "CODEOWNERS", "**/*.pem", "**/.env*", "infra/production/**"],
    validation_commands: ["npm run lint", "npm test"],
    codegraph: { max_files: 100, blame_lookback_days: 365 },
  },
  people: [
    {
      github: "platform-maintainer",
      active: true,
      main_agent: "codex",
      responsibilities: {
        domains: ["auth", "api"],
        labels: ["area/auth", "area/backend"],
        keywords: ["oauth", "login", "session", "api"],
        paths: ["src/auth/**", "src/api/**"],
      },
      review: { can_review: true, high_risk_domains: ["auth"], high_risk_paths: ["src/auth/**", "infra/**"] },
    },
    {
      github: "frontend-owner",
      active: true,
      main_agent: "claude",
      responsibilities: {
        domains: ["frontend"],
        labels: ["area/frontend"],
        keywords: ["ui", "react", "accessibility"],
        paths: ["src/components/**", "src/pages/**"],
      },
      review: { can_review: true, high_risk_domains: ["accessibility"], high_risk_paths: [] },
    },
    {
      github: "inactive-owner",
      active: false,
      main_agent: "codex",
      responsibilities: { labels: ["area/auth"], domains: ["auth"], keywords: ["session"], paths: ["src/**"] },
      review: { can_review: true, high_risk_domains: ["auth"], high_risk_paths: ["src/**"] },
    },
  ],
};

const pipelinePath = fileURLToPath(new URL("../pipeline.mjs", import.meta.url));

function passingState(overrides = {}) {
  const sha = "a".repeat(40);
  return initialState({
    issue: 12,
    phase: "review",
    iteration: 2,
    branch: "agent/issue-12-session",
    pr: 34,
    current_sha: sha,
    validation: {
      passed: true,
      commands: [
        { command: "npm run lint", passed: true, exit_code: 0 },
        { command: "npm test", passed: true, exit_code: 0 },
      ],
    },
    protected_paths: { passed: true, matched: [] },
    change_scope: {
      passed: true,
      commit_unit: "single_crud_bundle",
      pr_unit: "single_semantic_unit",
      additions: 200,
      deletions: 0,
      changed_lines: 200,
      target: 200,
      maximum: 400,
      binary: false,
      split_required: false,
      recommended_pr_count: 1,
      reason: "within_target",
    },
    ...overrides,
  });
}

function livePull({ sha = "a".repeat(40), draft = true, state = "open", merged = false } = {}) {
  return {
    number: 34,
    node_id: "PR_node",
    state,
    merged,
    draft,
    html_url: "https://example.test/pull/34",
    head: { sha, ref: "agent/issue-12-session", repo: { full_name: "o/r" } },
    base: { sha: "c".repeat(40), ref: "main", repo: { full_name: "o/r" } },
  };
}

test("policy YAML subset parses nested sequences and quoted globs", () => {
  const parsed = parseYaml(`
version: 1
pipeline:
  bootstrap_agent: codex
  protected_paths:
    - "**/*.pem"
people:
  - github: maintainer
    active: true
    roles:
      - reviewer
`);
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.pipeline.protected_paths, ["**/*.pem"]);
  assert.equal(parsed.people[0].github, "maintainer");
  assert.deepEqual(parsed.people[0].roles, ["reviewer"]);
});

test("glob matching implements repository ** semantics", () => {
  assert.equal(matchesGlob("server.pem", "**/*.pem"), true);
  assert.equal(matchesGlob("keys/server.pem", "**/*.pem"), true);
  assert.equal(matchesGlob("src/auth/session.ts", "src/auth/**"), true);
  assert.equal(matchesGlob("src/author.ts", "src/auth/**"), false);
  assert.equal(globToRegExp("CODEOWNERS").test("CODEOWNERS"), true);
});

test("NUL-delimited git paths preserve newlines and non-ASCII names", () => {
  assert.deepEqual(pathsFromNul("src/일반.ts\0docs/line\nbreak.md\0"), ["src/일반.ts", "docs/line\nbreak.md"]);
});

test("small PRs are allowed while oversized PRs require semantic splitting", () => {
  const patch = (additions, deletions) => [
    "diff --git a/x b/x",
    "--- a/x",
    "+++ b/x",
    ...Array.from({ length: deletions }, (_, index) => `-old ${index}`),
    ...Array.from({ length: additions }, (_, index) => `+new ${index}`),
  ].join("\n");
  assert.equal(evaluateChangeScope(team, patch(1, 0)).passed, true);
  assert.equal(evaluateChangeScope(team, patch(199, 0)).reason, "below_target_allowed");
  assert.equal(evaluateChangeScope(team, patch(200, 0)).passed, true);
  assert.equal(evaluateChangeScope(team, patch(250, 150)).passed, true);
  const oversized = evaluateChangeScope(team, patch(401, 0));
  assert.equal(oversized.reason, "above_maximum_split_required");
  assert.equal(oversized.split_required, true);
  assert.equal(oversized.human_required, false);
  assert.equal(oversized.recommended_pr_count, 2);
  const decision = evaluateAllOk(
    { verdict: "pass", reviewed_sha: "a".repeat(40), findings: [] },
    passingState({ change_scope: oversized }),
  );
  assert.equal(decision.all_ok, false);
  assert.equal(decision.split_required, true);
  assert.equal(decision.human_required, false);
  assert.equal(decision.next_phase, "split_required");
  assert.equal(evaluateChangeScope(team, "diff --git a/a.png b/a.png\nGIT binary patch\nliteral 1\nA" ).reason, "binary_line_count_unknown");
});

test("event gate requires approval for external intake and ignores bot comments", () => {
  const external = gateEvent(
    { action: "opened", issue: { number: 7, title: "Bug", author_association: "CONTRIBUTOR", labels: [] }, sender: { login: "guest", type: "User" } },
    "issues",
    team,
  );
  assert.equal(external.allowed, false);
  assert.equal(external.approval_required, true);
  assert.equal(external.action, "approval-required");

  const botComment = gateEvent(
    {
      action: "created",
      issue: { number: 7 },
      comment: { body: "/agent resume", author_association: "OWNER", user: { login: "agent[bot]", type: "Bot" } },
    },
    "issue_comment",
    team,
  );
  assert.equal(botComment.allowed, false);
  assert.equal(botComment.reason, "bot_event_ignored");
});

test("protected approval gate accepts only the complete structured command", () => {
  const issue = {
    number: 7,
    title: "Update owners",
    body: '<!-- agent-protected-request:v1 {"paths":["CODEOWNERS"]} -->',
  };
  const command = '/agent approve-protected {"issue":7,"paths":["CODEOWNERS"]}';
  const allowed = gateEvent(
    { action: "created", issue, comment: { body: command, author_association: "MEMBER", user: { login: "reviewer", type: "User" } } },
    "issue_comment",
    team,
  );
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.phase, "triage");
  const prose = gateEvent(
    { action: "created", issue, comment: { body: `${command} approved`, author_association: "MEMBER", user: { login: "reviewer", type: "User" } } },
    "issue_comment",
    team,
  );
  assert.equal(prose.allowed, false);
});

test("event gate allows bot synchronize only for same-repository agent branches", () => {
  const event = {
    action: "synchronize",
    sender: { login: "pipeline[bot]", type: "Bot" },
    repository: { default_branch: "main", full_name: "o/r" },
    pull_request: {
      number: 22,
      state: "open",
      merged: false,
      body: "Closes #11",
      head: { ref: "agent/issue-11-fix", sha: "b".repeat(40), repo: { full_name: "o/r" } },
      base: { ref: "main", sha: "a".repeat(40), repo: { full_name: "o/r" } },
    },
  };
  const result = gateEvent(event, "pull_request", team);
  assert.equal(result.allowed, true);
  assert.equal(result.phase, "review");
  assert.equal(result.source_issue_number, 11);
  assert.equal(result.base_sha, "a".repeat(40));
  assert.equal(result.checkout_ref, "b".repeat(40));
  event.pull_request.base.ref = "untrusted-base";
  assert.equal(gateEvent(event, "pull_request", team).reason, "fork_non_agent_or_non_default_base");
  event.pull_request.base.ref = "main";
  event.pull_request.head.repo.full_name = "fork/r";
  assert.equal(gateEvent(event, "pull_request", team).allowed, false);
  event.pull_request.head.repo.full_name = "o/r";
  event.pull_request.base.repo.full_name = "other/r";
  assert.equal(gateEvent(event, "pull_request", team).allowed, false);
});

test("manual dispatch requires an explicit Issue or PR target", () => {
  const result = gateEvent({ repository: { default_branch: "main" } }, "workflow_dispatch", team);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "manual_dispatch_requires_issue_or_pr");
});

test("manual PR dispatch still enforces repository, branch, base, and Issue identity", () => {
  const event = {
    repository: { default_branch: "main", full_name: "o/r" },
    pull_request: {
      number: 22,
      state: "open",
      merged: false,
      body: "Closes #11",
      head: { ref: "agent/issue-11-fix", sha: "b".repeat(40), repo: { full_name: "o/r" } },
      base: { ref: "main", sha: "a".repeat(40), repo: { full_name: "o/r" } },
    },
  };
  assert.equal(gateEvent(event, "workflow_dispatch", team, { dispatch_pr: 22, dispatch_issue: 11 }).allowed, true);
  assert.equal(gateEvent(event, "workflow_dispatch", team, { dispatch_pr: 22, dispatch_issue: 12 }).reason, "dispatch_issue_pr_mismatch");
  event.pull_request.base.ref = "release";
  assert.equal(gateEvent(event, "workflow_dispatch", team, { dispatch_pr: 22 }).reason, "fork_non_agent_or_non_default_base");
  event.pull_request.base.ref = "main";
  event.pull_request.state = "closed";
  assert.equal(gateEvent(event, "workflow_dispatch", team, { dispatch_pr: 22 }).reason, "fork_non_agent_or_non_default_base");
});

test("external review activity cannot trigger the write-capable loop", () => {
  const event = {
    action: "submitted",
    review: { author_association: "CONTRIBUTOR", user: { login: "guest", type: "User" } },
    pull_request: {
      number: 22,
      state: "open",
      merged: false,
      body: "Closes #11",
      head: { ref: "agent/issue-11-fix", sha: "b".repeat(40), repo: { full_name: "o/r" } },
      base: { ref: "main", sha: "a".repeat(40), repo: { full_name: "o/r" } },
    },
  };
  assert.equal(gateEvent(event, "pull_request_review", team).reason, "review_activity_requires_write_access");
  event.review.author_association = "MEMBER";
  assert.equal(gateEvent(event, "pull_request_review", team).allowed, true);
});

test("initial issue branch includes deterministic slug", () => {
  const event = { action: "opened", issue: { number: 8, title: "Expired session reuse!", author_association: "MEMBER" } };
  const result = gateEvent(event, "issues", team);
  assert.equal(result.branch, "agent/issue-8-expired-session-reuse");
  assert.equal(branchName(team, 8, "Expired session reuse!"), result.branch);
});

test("unit-scoped branch names stay distinct per semantic unit on the same Issue", () => {
  const first = branchName(team, 12, "Session bug fix", "U1");
  const second = branchName(team, 12, "Docs update", "U2");
  assert.equal(first, "agent/issue-12-u1-session-bug-fix");
  assert.equal(second, "agent/issue-12-u2-docs-update");
  assert.notEqual(first, second);
  assert.equal(branchName(team, 12, "Session bug fix"), "agent/issue-12-session-bug-fix");
});

test("owner selection uses label/domain/keyword weights and a single fallback", () => {
  const selected = selectOwner(team, {
    title: "Login session regression",
    body: "OAuth API requests fail",
    labels: [{ name: "area/auth" }],
  });
  assert.equal(selected.assignee, "platform-maintainer");
  assert.equal(selected.score, 100);
  assert.equal(selected.candidates.some((candidate) => candidate.github === "inactive-owner"), false);
  assert.equal(routeAgent(team, selected.assignee).agent, "codex");

  const fallback = selectOwner(team, { title: "Typo", body: "small copy edit", labels: [] });
  assert.equal(fallback.assignee, "platform-maintainer");
  assert.equal(fallback.used_fallback, true);
});

test("PR team score caps assignees and excludes implementer from reviewer", () => {
  const result = selectPrTeam(team, {
    changed_paths: ["src/auth/session.ts", "src/components/Login.tsx"],
    issue_assignee: "platform-maintainer",
    implementer: "platform-maintainer",
    domains: ["frontend"],
    risk: "low",
  });
  assert.deepEqual(result.assignees, ["platform-maintainer", "frontend-owner"]);
  assert.equal(result.reviewer, "frontend-owner");
  assert.equal(result.candidates[0].score, 180);
});

test("protected and deterministic high-risk rules override agent low risk", () => {
  const blocked = checkProtectedPaths(team, ["src/app.ts", ".github/workflows/release.yml"]);
  assert.equal(blocked.passed, false);
  assert.deepEqual(blocked.matched, [".github/workflows/release.yml"]);
  assert.equal(checkProtectedPaths(team, [".github/workflows/release.yml"], true).passed, true);

  const risk = evaluateRisk(team, { paths: ["src/auth/session.ts"], risk: "low" });
  assert.equal(risk.risk, "high");
  assert.equal(risk.deterministic_high, true);
  assert.equal(evaluateRisk(team, { paths: ["src/components/Button.tsx"], risk: "low" }).risk, "low");

  for (const category of team.pipeline.risk_policy.categories) {
    const candidate = evaluateRisk(team, {
      body: `This change touches ${category.signals[0]}`,
      risk: "low",
      risk_assessment: { impact: "limited", likelihood: "unlikely", blast_radius: "local", reversibility: "easy", detectability: "strong", evidence: "bounded" },
    });
    assert.equal(candidate.risk, "low", `${category.id} candidate`);
    assert(candidate.candidate_categories.some((entry) => entry.category === category.id), category.id);
    const material = evaluateRisk(team, { body: `This change may cause ${category.high_impact_signals[0]}`, risk: "low" });
    assert.equal(material.risk, "high", `${category.id} material`);
    assert(material.categories.includes(category.id), category.id);
  }
  const onePercent = evaluateRisk(team, {
    body: "Resource consumption increases by 1% within existing headroom; SLO and fleet cost are unchanged",
    risk: "low",
    risk_categories: ["performance_capacity"],
    risk_assessment: { impact: "negligible", likelihood: "likely", blast_radius: "local", reversibility: "easy", detectability: "strong", evidence: "benchmark and capacity report" },
  });
  assert.equal(onePercent.risk, "low");
  const equivalent = evaluateRisk(team, {
    risk: "high",
    risk_categories: ["equivalent_severity"],
    risk_assessment: { impact: "material", likelihood: "possible", blast_radius: "contained", reversibility: "managed", detectability: "adequate", evidence: "analogous material impact" },
  });
  assert.equal(equivalent.risk, "high");
  assert.deepEqual(equivalent.categories, ["equivalent_severity"]);
});

test("protected authorization requires exact request, eligible human coverage, and implementer separation", () => {
  const protectedTeam = structuredClone(team);
  protectedTeam.people.push({
    github: "release-reviewer",
    active: true,
    main_agent: "codex",
    responsibilities: { domains: [], labels: [], keywords: [], paths: ["CODEOWNERS", ".github/agent-pipeline/**"] },
    review: { can_review: true, high_risk_domains: [], high_risk_paths: ["CODEOWNERS", ".github/agent-pipeline/**", ".github/workflows/**"] },
  });
  const issue = { number: 7, title: "Owners", body: '<!-- agent-protected-request:v1 {"paths":["CODEOWNERS"]} -->' };
  const body = '/agent approve-protected {"issue":7,"paths":["CODEOWNERS"]}';
  const comment = {
    id: 91,
    updated_at: "2026-08-20T00:00:00Z",
    body,
    author_association: "MEMBER",
    user: { login: "release-reviewer", type: "User" },
  };
  assert.deepEqual(parseProtectedRequest(issue).paths, ["CODEOWNERS"]);
  assert.equal(parseProtectedApprovalCommand(body).valid, true);
  assert.equal(parseProtectedApprovalCommand(`${body}\n`).valid, false);
  assert.equal(parseProtectedRequest({ body: '<!-- agent-protected-request:v1 {"paths":["../CODEOWNERS"]} -->' }).valid, false);

  const approved = authorizeProtectedPaths(protectedTeam, {
    issue,
    comments: [[comment]],
    paths: ["CODEOWNERS"],
    state: { assignee: "platform-maintainer" },
    evidence_fresh: true,
  });
  assert.equal(approved.passed, true);
  assert.equal(approved.approved_by, "release-reviewer");
  assert.equal(approved.approval_comment_id, 91);

  const selfApproved = authorizeProtectedPaths(protectedTeam, {
    issue,
    comments: [comment],
    paths: ["CODEOWNERS"],
    state: { assignee: "release-reviewer" },
    evidence_fresh: true,
  });
  assert.equal(selfApproved.passed, false);
  assert(selfApproved.rejected_approvals.some((entry) => entry.reason === "reviewer_is_implementer"));

  const stale = authorizeProtectedPaths(protectedTeam, { issue, comments: [comment], paths: ["CODEOWNERS"], state: { assignee: "platform-maintainer" } });
  assert.equal(stale.reason, "fresh_api_evidence_required");

  const workflowIssue = {
    number: 7,
    title: "Workflow",
    body: '<!-- agent-protected-request:v1 {"paths":[".github/workflows/release.yml"]} -->',
  };
  const manualOnly = authorizeProtectedPaths(protectedTeam, {
    issue: workflowIssue,
    comments: [],
    paths: [".github/workflows/release.yml"],
    state: { assignee: "platform-maintainer" },
    evidence_fresh: true,
  });
  assert.equal(manualOnly.passed, false);
  assert.equal(manualOnly.reason, "workflow_definition_requires_manual_change");
});

test("provider envelopes normalize and unknown privacy escalates triage", () => {
  const claude = {
    structured_output: JSON.stringify({
      assignee: "platform-maintainer",
      agent: "claude",
      risk: "low",
      risk_categories: [],
      risk_assessment: {
        impact: "limited",
        likelihood: "possible",
        blast_radius: "contained",
        reversibility: "easy",
        detectability: "adequate",
        evidence: "Issue-reported impact is contained",
      },
      domains: ["auth"],
      changed_paths: [],
      rationale: "Auth issue",
      intake: {
        problem: "Cannot log in",
        reproduction_steps: ["Open app"],
        expected_result: "Login",
        actual_result: "Error",
        impact: "Users blocked",
        relevant_logs: [],
        security_or_privacy: "unknown",
      },
    }),
  };
  const result = normalizeAgentOutput(claude, "triage", { agent: "claude" });
  assert.equal(result.agent, "claude");
  assert.equal(result.risk, "high");
  assert.equal(result.intake.security_or_privacy, "unknown");

  const smallResourceDelta = JSON.parse(claude.structured_output);
  smallResourceDelta.risk = "low";
  smallResourceDelta.risk_categories = ["performance_capacity"];
  smallResourceDelta.risk_assessment = {
    impact: "negligible",
    likelihood: "likely",
    blast_radius: "local",
    reversibility: "easy",
    detectability: "strong",
    evidence: "Measured 1% increase remains within headroom and does not affect SLOs",
  };
  smallResourceDelta.intake.security_or_privacy = "none";
  const small = normalizeAgentOutput(smallResourceDelta, "triage");
  assert.equal(small.risk, "low");
  assert.deepEqual(small.risk_categories, ["performance_capacity"]);

  const review = normalizeAgentOutput(
    `{"verdict":"fix_required","reviewed_sha":"${"a".repeat(40)}","findings":[{"id":"P-001","path":"x","line":2,"problem":"unknown risk","risk":"unknown","must_fix":true,"suggested_fix":"Investigate","human_owner":null}]}`,
    "review",
  );
  assert.equal(review.verdict, "fix_required");
  assert.equal(review.findings[0].risk, "high");
  assert.equal(review.findings[0].must_fix, true);
});

test("canonical progress comment round-trips assignee and plan", () => {
  const state = passingState({
    assignee: "platform-maintainer",
    agent: "codex",
    plan: { steps: ["Add regression test"] },
    problems: [
      { id: "P-001", problem: "Session reuse", risk: "high", status: "HUMAN_REQUIRED", evidence: "src/auth/session.ts:84", owner: "platform-maintainer", next_step: "Human judgment" },
    ],
  });
  const markdown = renderProgress(state);
  assert.match(markdown, /Agent 진행 현황 — Iteration 2/);
  assert.match(markdown, /@platform-maintainer/);
  const recovered = parseStateComment(markdown);
  assert.equal(recovered.assignee, "platform-maintainer");
  assert.deepEqual(recovered.plan, { steps: ["Add regression test"] });
});

test("draft PR body deterministically includes plan, files, validation, and risk", () => {
  const state = passingState({ plan: { risk: "low", steps: ["Add guard", "Add regression test"] } });
  const body = renderPullRequestBody({ changed_paths: ["tests/session.test.ts", "src/auth/session.ts"] }, state, 12);
  assert.match(body, /^Closes #12/);
  assert.match(body, /1\. Add guard/);
  assert.match(body, /`src\/auth\/session\.ts`/);
  assert.match(body, /✅ `npm test` \(exit 0\)/);
  assert.match(body, /최종 위험도: \*\*low\*\*/);
  assert.match(body, /자동 merge되지 않습니다/);
});

test("normalization rejects prose and incomplete/default-manufacturing payloads", () => {
  assert.throws(() => normalizeAgentOutput("Review looks good to me", "review"), /does not contain JSON/);
  assert.throws(
    () => normalizeAgentOutput(`\`\`\`json\n{"verdict":"pass","reviewed_sha":"${"a".repeat(40)}","findings":[]}\n\`\`\``, "review"),
    /does not contain JSON/,
  );
  assert.throws(
    () => normalizeAgentOutput({ verdict: "pass", findings: [] }, "review"),
    (error) => error instanceof PipelineError && error.code === "INVALID_AGENT_OUTPUT" && error.details.errors.some((message) => message.includes("reviewed_sha")),
  );
  assert.throws(
    () => normalizeAgentOutput({ risk: "low" }, "triage"),
    (error) => error instanceof PipelineError && error.code === "INVALID_AGENT_OUTPUT",
  );
  assert.throws(
    () => normalizeAgentOutput({ verdict: "fix_required", reviewed_sha: "a".repeat(40), findings: [] }, "review"),
    (error) => error instanceof PipelineError && error.details.errors.some((message) => message.includes("must-fix")),
  );
  assert.throws(
    () => normalizeAgentOutput({ verdict: "pass", reviewed_sha: "a".repeat(40), findings: [{ id: "P-1", path: "x", line: 1, problem: "x", risk: "low", must_fix: true, suggested_fix: "fix", human_owner: null }] }, "review"),
    (error) => error instanceof PipelineError && error.details.errors.some((message) => message.includes("verdict is pass")),
  );
});

test("All OK is exact and stale SHA invalidates a prior pass", () => {
  const sha = "a".repeat(40);
  const review = { verdict: "pass", reviewed_sha: sha, findings: [] };
  const passed = evaluateAllOk(review, passingState());
  assert.equal(passed.all_ok, true);
  assert.equal(passed.auto_fix, false);

  const stale = evaluateAllOk(review, passingState({ current_sha: "b".repeat(40) }));
  assert.equal(stale.all_ok, false);
  assert.equal(stale.checks.reviewed_current_head, false);
  const blocked = evaluateAllOk(review, passingState({ protected_paths: { passed: false, matched: ["CODEOWNERS"] } }));
  assert.equal(blocked.human_required, true);

  const scopeOnly = evaluateAllOk(
    review,
    passingState({
      protected_paths: {
        passed: true,
        matched: ["CODEOWNERS"],
        scope_approved_by: "platform-maintainer",
        scope_approval_comment_id: 22,
      },
    }),
  );
  assert.equal(scopeOnly.all_ok, false);
  assert.equal(scopeOnly.checks.protected_content_approved_for_head, false);
  const exactHead = evaluateAllOk(
    review,
    passingState({
      protected_paths: {
        passed: true,
        matched: ["CODEOWNERS"],
        scope_approved_by: "platform-maintainer",
        scope_approval_comment_id: 22,
        content_approved_by: "frontend-owner",
        content_approved_sha: sha,
      },
    }),
  );
  assert.equal(exactHead.all_ok, true);

  const persisted = evaluateAllOk(
    review,
    passingState({
      problems: [
        { id: "P-009", problem: "Prior auth finding", risk: "high", status: "HUMAN_REQUIRED", evidence: "src/auth/a.ts:1", owner: "platform-maintainer", next_step: "Review" },
      ],
    }),
  );
  assert.equal(persisted.all_ok, false);
  assert.deepEqual(persisted.unresolved_high_risk, ["P-009"]);
});

test("review findings become one bounded next-cycle plan", () => {
  const result = planFromReview(
    team,
    {
      verdict: "fix_required",
      reviewed_sha: "a".repeat(40),
      findings: [{ id: "P-002", path: "src/a.ts", line: 4, problem: "Missing test", risk: "low", must_fix: true, suggested_fix: "Add test", human_owner: null }],
    },
    passingState({ iteration: 2 }),
  );
  assert.equal(result.iteration, 3);
  assert.equal(result.human_required, false);
  assert.deepEqual(result.steps, ["Add test"]);
  assert.equal(result.problems[0].status, "PLANNED");

  const exhaustedTeam = structuredClone(team);
  exhaustedTeam.pipeline.max_auto_iterations = 2;
  assert.equal(
    planFromReview(
      exhaustedTeam,
      {
        verdict: "fix_required",
        reviewed_sha: "a".repeat(40),
        findings: [
          { id: "P-002", path: "src/a.ts", line: 4, problem: "Missing test", risk: "low", must_fix: true, suggested_fix: "Add test", human_owner: null },
        ],
      },
      passingState({ iteration: 2 }),
    ).human_required,
    true,
  );
});

test("review fix iterations cannot downgrade prior deterministic high risk", () => {
  const result = planFromReview(
    team,
    {
      verdict: "fix_required",
      reviewed_sha: "a".repeat(40),
      findings: [{ id: "P-003", path: "src/a.ts", line: 2, problem: "Low finding", risk: "low", must_fix: true, suggested_fix: "Fix it", human_owner: null }],
    },
    passingState({ plan: { risk: "high", risk_context: { domains: ["auth"], intake_security: "unknown", reasons: ["privacy_unknown"] } } }),
  );
  assert.equal(result.risk, "high");
  assert.deepEqual(result.risk_context.domains, ["auth"]);
});

test("plan reconciliation pins Issue, iteration, validation policy, and max", () => {
  const modelPlan = {
    issue: 999,
    iteration: 88,
    phase: "plan",
    risk: "low",
    problems: [
      { id: "P-001", problem: "Fix bug", risk: "low", status: "PLANNED", evidence: "src/a.js:1", owner: null, next_step: "Edit" },
    ],
    steps: ["Edit the implementation"],
    validation_commands: ["true"],
    changed_paths: ["src/a.js"],
    units: [],
  };
  const reconciled = reconcilePlan(team, modelPlan, passingState({ iteration: 2, problems: [] }));
  assert.equal(reconciled.plan.issue, 12);
  assert.equal(reconciled.plan.iteration, 3);
  assert.deepEqual(reconciled.plan.validation_commands, team.pipeline.validation_commands);
  assert.deepEqual(reconciled.corrections.sort(), ["issue", "iteration", "validation_commands"]);
  assert.equal(reconciled.split, false);
  assert.deepEqual(reconciled.units, []);

  const exhausted = reconcilePlan(team, modelPlan, passingState({ iteration: 5, problems: [] }));
  assert.equal(exhausted.human_required, true);
  assert.equal(exhausted.plan.iteration, 5);
  assert(exhausted.plan.problems.some((problem) => problem.id === "P-700000000" && problem.status === "HUMAN_REQUIRED"));
});

function twoUnitPlan(overrides = {}) {
  return {
    issue: 12,
    iteration: 1,
    phase: "plan",
    risk: "low",
    problems: [
      { id: "P-001", problem: "세션 만료 버그 수정", risk: "low", status: "PLANNED", evidence: "src/a.js:1", owner: null, next_step: "Edit" },
      { id: "P-002", problem: "README 갱신", risk: "low", status: "PLANNED", evidence: "docs/readme.md:1", owner: null, next_step: "Edit" },
    ],
    steps: ["Edit src/a.js", "Edit docs/readme.md"],
    validation_commands: ["true"],
    changed_paths: ["src/a.js", "docs/readme.md"],
    units: [
      { id: "U1", title: "Session bug fix", problem_ids: ["P-001"], steps: ["Edit src/a.js"], changed_paths: ["src/a.js"] },
      { id: "U2", title: "Docs update", problem_ids: ["P-002"], steps: ["Edit docs/readme.md"], changed_paths: ["docs/readme.md"] },
    ],
    ...overrides,
  };
}

test("a valid multi-unit split produces independently branched, disjoint per-unit plans", () => {
  const reconciled = reconcilePlan(team, twoUnitPlan(), passingState({ iteration: 0, problems: [] }));
  assert.equal(reconciled.split, true);
  assert.equal(reconciled.split_reason, "valid");
  assert.equal(reconciled.units.length, 2);
  assert.deepEqual(reconciled.units.map((unit) => unit.id), ["U1", "U2"]);
  assert.deepEqual(reconciled.units[0].problems.map((problem) => problem.id), ["P-001"]);
  assert.deepEqual(reconciled.units[1].problems.map((problem) => problem.id), ["P-002"]);
  assert.equal(reconciled.units[0].branch, "agent/issue-12-u1-session-bug-fix");
  assert.equal(reconciled.units[1].branch, "agent/issue-12-u2-docs-update");
  assert.notEqual(reconciled.units[0].branch, reconciled.units[1].branch);
  // The whole-issue reconciled plan keeps carrying every problem, so a caller
  // that ignores splitting entirely still sees the same behavior as before.
  assert.equal(reconciled.plan.problems.length, 2);
});

test("an invalid split (overlapping path or uncovered problem) falls back to a single reviewable PR", () => {
  const overlappingPaths = reconcilePlan(
    team,
    twoUnitPlan({
      units: [
        { id: "U1", title: "A", problem_ids: ["P-001"], steps: ["Edit src/a.js"], changed_paths: ["src/a.js"] },
        { id: "U2", title: "B", problem_ids: ["P-002"], steps: ["Edit src/a.js"], changed_paths: ["src/a.js"] },
      ],
    }),
    passingState({ iteration: 0, problems: [] }),
  );
  assert.equal(overlappingPaths.split, false);
  assert.deepEqual(overlappingPaths.units, []);
  assert.equal(overlappingPaths.split_reason, "changed_path_claimed_by_multiple_units");
  assert.equal(overlappingPaths.plan.problems.length, 2);

  const uncoveredProblem = reconcilePlan(
    team,
    twoUnitPlan({
      problems: [
        { id: "P-001", problem: "Fix a", risk: "low", status: "PLANNED", evidence: "src/a.js:1", owner: null, next_step: "Edit" },
        { id: "P-002", problem: "Fix b", risk: "low", status: "PLANNED", evidence: "src/b.js:1", owner: null, next_step: "Edit" },
        { id: "P-003", problem: "Fix c", risk: "low", status: "PLANNED", evidence: "src/c.js:1", owner: null, next_step: "Edit" },
      ],
      changed_paths: ["src/a.js", "src/b.js", "src/c.js"],
      units: [
        { id: "U1", title: "A", problem_ids: ["P-001"], steps: ["Edit src/a.js"], changed_paths: ["src/a.js"] },
        { id: "U2", title: "B", problem_ids: ["P-002"], steps: ["Edit src/b.js"], changed_paths: ["src/b.js"] },
      ],
    }),
    passingState({ iteration: 0, problems: [] }),
  );
  assert.equal(uncoveredProblem.split, false);
  assert.equal(uncoveredProblem.split_reason, "problem_not_assigned_to_any_unit");

  const duplicateId = reconcilePlan(
    team,
    twoUnitPlan({
      units: [
        { id: "U1", title: "A", problem_ids: ["P-001"], steps: ["Edit src/a.js"], changed_paths: ["src/a.js"] },
        { id: "U1", title: "B", problem_ids: ["P-002"], steps: ["Edit docs/readme.md"], changed_paths: ["docs/readme.md"] },
      ],
    }),
    passingState({ iteration: 0, problems: [] }),
  );
  assert.equal(duplicateId.split, false);
  assert.equal(duplicateId.split_reason, "duplicate_unit_id");
});

test("units-index progress rendering shows each spawned unit's branch and PR", () => {
  const overview = initialState({
    issue: 12,
    unit: null,
    phase: "split_required",
    units_index: [
      { id: "U1", title: "세션 버그 수정", branch: "agent/issue-12-u1-session-bug-fix", pr: 101 },
      { id: "U2", title: "문서 업데이트", branch: "agent/issue-12-u2-document-update", pr: null },
    ],
  });
  const body = renderProgress(overview);
  assert.match(body, /Agent 진행 현황 — Iteration 0/);
  assert.match(body, /2개의 독립적인 semantic-unit PR/);
  assert.match(body, /U1 \| 세션 버그 수정 \| `agent\/issue-12-u1-session-bug-fix` \| #101/);
  assert.match(body, /U2 \| 문서 업데이트 \| `agent\/issue-12-u2-document-update` \| 생성 대기/);

  const unitState = initialState({ issue: 12, unit: "U1", iteration: 1 });
  assert.match(renderProgress(unitState), /Agent 진행 현황 — Unit U1 · Iteration 1/);
});

test("validation-only review failure produces a stable actionable plan problem", () => {
  const review = { verdict: "pass", reviewed_sha: "a".repeat(40), findings: [] };
  const failed = passingState({
    validation: { passed: false, commands: [{ command: "npm test", passed: false, exit_code: 1 }] },
  });
  const first = planFromReview(team, review, failed);
  const second = planFromReview(team, review, failed);
  assert.equal(first.human_required, false);
  assert.equal(first.problems.length, 1);
  assert.match(first.problems[0].id, /^P-[0-9]{3,}$/);
  assert.equal(first.problems[0].id, second.problems[0].id);
  assert.match(first.steps[0], /npm test/);
});

test("CodeGraph includes imports, ownership, tests, and is stable apart from git data", () => {
  const repo = mkdtempSync(join(tmpdir(), "pipeline-graph-"));
  mkdirSync(join(repo, "src", "auth"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "src", "auth", "session.js"), "export const session = 1;\n");
  writeFileSync(join(repo, "src", "auth", "login.js"), "import { session } from './session.js';\nconsole.log(session);\n");
  writeFileSync(join(repo, "tests", "session.test.js"), "import '../src/auth/session.js';\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "platform-maintainer"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "platform-maintainer@example.test"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });

  const graph = buildCodegraph(team, { repo, blame_files: ["src/auth/session.js"] });
  assert.equal(graph.file_count, 3);
  assert.equal("generated_at" in graph, false);
  assert(graph.edges.some((edge) => edge.type === "imports" && edge.from.endsWith("login.js") && edge.to.endsWith("session.js")));
  assert(graph.edges.some((edge) => edge.type === "owns" && edge.to.endsWith("session.js")));
  assert(graph.edges.some((edge) => edge.type === "tests" && edge.from.endsWith("session.test.js")));
  assert(graph.edges.some((edge) => edge.type === "blame" && edge.github === "platform-maintainer"));
});

test("create-patch captures tracked and untracked files", () => {
  const repo = mkdtempSync(join(tmpdir(), "pipeline-patch-"));
  writeFileSync(join(repo, "tracked.txt"), "before\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });
  writeFileSync(join(repo, "tracked.txt"), "after\n");
  writeFileSync(join(repo, "new.txt"), "new\n");
  const result = createPatch({ repo });
  assert.deepEqual(result.changed_paths.sort(), ["new.txt", "tracked.txt"]);
  assert.match(result.patch, /new file mode/);
});

test("create-patch reports both sides of a rename", () => {
  const repo = mkdtempSync(join(tmpdir(), "pipeline-rename-"));
  writeFileSync(join(repo, "before.txt"), "same contents\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });
  execFileSync("git", ["mv", "before.txt", "after.txt"], { cwd: repo });
  const result = createPatch({ repo });
  assert.deepEqual(result.changed_paths.sort(), ["after.txt", "before.txt"]);
  assert.match(result.patch, /rename from before\.txt/);
  assert.match(result.patch, /rename to after\.txt/);
});

test("loadState recovers the newest canonical comment", async () => {
  const older = renderProgress(passingState({ iteration: 1 }));
  const newer = renderProgress(passingState({ iteration: 3, assignee: "frontend-owner" }));
  const fake = {
    appId: "123",
    botLogin: "",
    repoPath: (suffix) => `/repos/o/r${suffix}`,
    paginate: async () => [
      { id: 99, updated_at: "2026-01-03T00:00:00Z", performed_via_github_app: { id: 999 }, body: newer },
      { id: 1, updated_at: "2026-01-01T00:00:00Z", performed_via_github_app: { id: 123 }, body: older },
      { id: 2, updated_at: "2026-01-02T00:00:00Z", performed_via_github_app: { id: 123 }, html_url: "https://example.test/comment/2", body: newer },
    ],
  };
  const state = await loadState(fake, { issue: 12 });
  assert.equal(state.iteration, 3);
  assert.equal(state.assignee, "frontend-owner");
});

test("canonical state comments disambiguate by PR, branch, and unit across a split Issue", async () => {
  const overview = renderProgress(initialState({ issue: 12, unit: null, phase: "split_required" }));
  const u1 = renderProgress(initialState({ issue: 12, unit: "U1", branch: "agent/issue-12-u1-session-bug-fix", pr: 101 }));
  const u2 = renderProgress(initialState({ issue: 12, unit: "U2", branch: "agent/issue-12-u2-docs-update", pr: 102 }));
  const fake = {
    appId: "123",
    botLogin: "",
    repoPath: (suffix) => `/repos/o/r${suffix}`,
    paginate: async () => [
      { id: 1, updated_at: "2026-01-01T00:00:00Z", performed_via_github_app: { id: 123 }, body: overview },
      { id: 2, updated_at: "2026-01-02T00:00:00Z", performed_via_github_app: { id: 123 }, body: u1 },
      { id: 3, updated_at: "2026-01-03T00:00:00Z", performed_via_github_app: { id: 123 }, body: u2 },
    ],
    request: async (method, path) => {
      if (method === "GET" && path.endsWith("/pulls/101")) {
        return { status: 200, data: { number: 101, head: { sha: "b".repeat(40), ref: "agent/issue-12-u1-session-bug-fix" } } };
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
  };
  const byPr = await findStateComment(fake, 12, { pr: 102 });
  assert.equal(byPr.state.unit, "U2");
  const byBranch = await findStateComment(fake, 12, { branch: "agent/issue-12-u1-session-bug-fix" });
  assert.equal(byBranch.state.unit, "U1");
  const byUnit = await findStateComment(fake, 12, { unit: "U1" });
  assert.equal(byUnit.comment.id, 2);
  // With no disambiguator (a bare Issue-only trigger, e.g. /agent resume),
  // resolution must land on the unit:null overview thread, never a random unit.
  const noDisambiguator = await findStateComment(fake, 12);
  assert.equal(noDisambiguator.state.unit, null);

  const resumedUnit = await loadState(fake, { issue: 12, pr: 101 });
  assert.equal(resumedUnit.unit, "U1");
  assert.equal(resumedUnit.branch, "agent/issue-12-u1-session-bug-fix");
});

test("split analysis publishes one overview comment plus one comment per semantic-unit branch", async () => {
  const created = [];
  const fake = {
    appId: "123",
    botLogin: "",
    repoPath: (suffix) => `/repos/o/r${suffix}`,
    paginate: async () => [],
    request: async (method, path, options = {}) => {
      if (method === "GET" && path.startsWith("/repos/o/r/assignees/")) return { status: 204, data: null };
      if (method === "POST" && path.endsWith("/issues/12/assignees")) return { status: 201, data: { assignees: [{ login: "platform-maintainer" }] } };
      if (method === "POST" && path.endsWith("/issues/12/comments")) {
        const id = created.length + 1;
        created.push({ id, body: options.body.body });
        return { status: 201, data: { id, html_url: `https://example.test/comment/${id}` } };
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
  };
  const reconciliation = {
    split: true,
    units: [
      {
        id: "U1",
        title: "Session bug fix",
        issue: 12,
        iteration: 1,
        phase: "plan",
        risk: "low",
        problems: [{ id: "P-001", problem: "Fix a", risk: "low", status: "PLANNED", evidence: "src/a.js:1", owner: null, next_step: "Edit" }],
        steps: ["Edit src/a.js"],
        validation_commands: ["npm test"],
        changed_paths: ["src/a.js"],
        branch: "agent/issue-12-u1-session-bug-fix",
      },
      {
        id: "U2",
        title: "Docs update",
        issue: 12,
        iteration: 1,
        phase: "plan",
        risk: "low",
        problems: [{ id: "P-002", problem: "Fix b", risk: "low", status: "PLANNED", evidence: "docs/readme.md:1", owner: null, next_step: "Edit" }],
        steps: ["Edit docs/readme.md"],
        validation_commands: ["npm test"],
        changed_paths: ["docs/readme.md"],
        branch: "agent/issue-12-u2-docs-update",
      },
    ],
  };
  const result = await publish(fake, "analysis", {
    issue: 12,
    owner: { assignee: "platform-maintainer", agent: "codex" },
    reconciliation,
  });
  assert.equal(result.split, true);
  assert.equal(result.units.length, 2);
  assert.equal(created.length, 3);
  assert.match(created[0].body, /2개의 독립적인 semantic-unit PR/);
  assert.match(created[0].body, /U1 \| Session bug fix \| `agent\/issue-12-u1-session-bug-fix` \| 생성 대기/);
  assert.match(created[0].body, /U2 \| Docs update \| `agent\/issue-12-u2-docs-update` \| 생성 대기/);
  assert.match(created[1].body, /Unit U1 · Iteration 1/);
  assert.match(created[1].body, /P-001/);
  assert.match(created[2].body, /Unit U2 · Iteration 1/);
  assert.match(created[2].body, /P-002/);
});

test("only the selected reviewer can resolve high risk at the exact head SHA", async () => {
  const sha = "a".repeat(40);
  const prior = passingState({
    reviewer: "frontend-owner",
    problems: [
      { id: "P-010", problem: "High risk", risk: "high", status: "HUMAN_REQUIRED", evidence: "src/x.ts:1", owner: "frontend-owner", next_step: "Approve" },
    ],
  });
  const fake = {
    appId: "123",
    botLogin: "",
    repoPath: (suffix) => `/repos/o/r${suffix}`,
    paginate: async () => [
      { id: 1, updated_at: "2026-01-01T00:00:00Z", performed_via_github_app: { id: 123 }, body: renderProgress(prior) },
    ],
  };
  const event = {
    action: "submitted",
    review: { state: "approved", commit_id: sha, author_association: "MEMBER", user: { login: "frontend-owner", type: "User" } },
    pull_request: {
      number: 34,
      body: "Closes #12",
      head: { ref: "agent/issue-12-session", sha, repo: { full_name: "o/r" } },
      base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "o/r" } },
    },
  };
  const approved = await loadState(fake, { event });
  assert.equal(approved.problems[0].status, "FIXED");
  assert.match(approved.problems[0].evidence, /approved by @frontend-owner/);

  event.review.user.login = "platform-maintainer";
  const wrongReviewer = await loadState(fake, { event });
  assert.equal(wrongReviewer.problems[0].status, "HUMAN_REQUIRED");
});

test("selected reviewer approval records protected content approval for the exact head", async () => {
  const sha = "d".repeat(40);
  const prior = passingState({
    reviewer: "frontend-owner",
    problems: [],
    protected_paths: {
      passed: true,
      matched: ["CODEOWNERS"],
      scope_approved_by: "platform-maintainer",
      scope_approval_comment_id: 88,
    },
  });
  const fake = {
    appId: "123",
    botLogin: "",
    repoPath: (suffix) => `/repos/o/r${suffix}`,
    paginate: async () => [
      { id: 1, updated_at: "2026-01-01T00:00:00Z", performed_via_github_app: { id: 123 }, body: renderProgress(prior) },
    ],
  };
  const state = await loadState(fake, {
    event: {
      action: "submitted",
      review: { state: "approved", commit_id: sha, author_association: "MEMBER", user: { login: "frontend-owner", type: "User" } },
      pull_request: {
        number: 34,
        body: "Closes #12",
        head: { ref: "agent/issue-12-session", sha, repo: { full_name: "o/r" } },
        base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "o/r" } },
      },
    },
  });
  assert.equal(state.protected_paths.content_approved_by, "frontend-owner");
  assert.equal(state.protected_paths.content_approved_sha, sha);
});

test("GitHub client redacts tokens from API failures", async () => {
  const client = new GitHubClient({
    token: "super-secret-token",
    repository: "o/r",
    api_url: "https://api.example.test",
    fetch: async () => new Response(JSON.stringify({ message: "Denied" }), { status: 403 }),
  });
  await assert.rejects(client.request("GET", client.repoPath("/issues/1")), (error) => {
    assert(error instanceof PipelineError);
    assert.equal(error.message.includes("super-secret-token"), false);
    return true;
  });
});

test("live publication rejects a closed canonical PR", async () => {
  const fake = {
    repository: "o/r",
    repoPath: (suffix) => `/repos/o/r${suffix}`,
    request: async (method, path) => {
      if (path === "/repos/o/r") return { status: 200, data: { default_branch: "main" } };
      if (path.endsWith("/pulls/34")) return { status: 200, data: livePull({ state: "closed" }) };
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  await assert.rejects(
    validateLivePublication(fake, { state: passingState() }),
    (error) => error instanceof PipelineError && error.code === "UNSAFE_PR_LIFECYCLE",
  );
});

test("publisher creates missing managed labels with fixed metadata", async () => {
  const created = [];
  const fake = {
    appId: "123",
    botLogin: "",
    repoPath: (suffix) => `/repos/o/r${suffix}`,
    paginate: async () => [],
    request: async (method, path, options = {}) => {
      if (method === "GET" && path.includes("/labels/")) return { status: 404, data: null };
      if (method === "POST" && path.endsWith("/labels") && !path.includes("/issues/")) created.push(options.body);
      return { status: 201, data: { id: 9, html_url: "https://example.test/comment/9" } };
    },
  };
  await publish(fake, "approval-required", { issue: 12 });
  assert.deepEqual(created, [
    {
      name: "agent:approval-required",
      color: "fbca04",
      description: "Maintainer approval is required before agent intake",
    },
  ]);
});

test("ready publisher rechecks live head and keeps stale reviews draft", async () => {
  const calls = [];
  const fake = {
    appId: "123",
    botLogin: "",
    repository: "o/r",
    repoPath: (suffix) => `/repos/o/r${suffix}`,
    request: async (method, path, options = {}) => {
      calls.push({ method, path, options });
      if (path === "/repos/o/r") return { status: 200, data: { default_branch: "main" } };
      if (path.endsWith("/pulls/34")) return { status: 200, data: livePull({ sha: "b".repeat(40) }) };
      if (path.includes("/comments")) return { status: 200, data: [] };
      return { status: 200, data: { id: 9, html_url: "https://example.test/comment/9" } };
    },
    paginate: async () => [],
  };
  const result = await publish(fake, "ready", {
    issue: 12,
    pr: 34,
    state: passingState(),
    review: { verdict: "pass", reviewed_sha: "a".repeat(40), findings: [] },
    evaluation: { all_ok: true },
  });
  assert.equal(result.draft, true);
  assert.equal(result.stale, true);
  assert.equal(calls.some((call) => String(call.path).includes("graphql")), false);
});

test("ready publisher top-level PR comment includes the final progress table", async () => {
  let prBody = "";
  const fake = {
    appId: "123",
    botLogin: "",
    repository: "o/r",
    repoPath: (suffix) => `/repos/o/r${suffix}`,
    paginate: async () => [],
    paginate: async () => [],
    request: async (method, path, options = {}) => {
      if (path === "/repos/o/r") return { status: 200, data: { default_branch: "main" } };
      if (path.endsWith("/pulls/34")) return { status: 200, data: livePull({ draft: false }) };
      if (method === "POST" && path.endsWith("/issues/34/comments")) prBody = options.body.body;
      return { status: 200, data: { id: 9, html_url: "https://example.test/comment/9" } };
    },
  };
  const result = await publish(fake, "ready", {
    issue: 12,
    pr: 34,
    state: passingState(),
    review: { verdict: "pass", reviewed_sha: "a".repeat(40), findings: [] },
    evaluation: { all_ok: true },
  });
  assert.equal(result.draft, false);
  assert.match(prBody, /Agent 진행 현황/);
  assert.match(prBody, /All OK/);
});

test("ready publisher prefers freshly persisted review observations", async () => {
  const fresh = passingState({
    problems: [
      { id: "P-041", problem: "New low-risk observation", risk: "low", status: "REVIEW_PENDING", evidence: "src/a.ts:3", owner: null, next_step: "Human review" },
    ],
  });
  let canonicalBody = "";
  const canonicalComment = {
    id: 5,
    updated_at: "2026-08-20T00:00:00Z",
    performed_via_github_app: { id: 123 },
    body: renderProgress(fresh),
  };
  const fake = {
    appId: "123",
    botLogin: "",
    repository: "o/r",
    repoPath: (suffix) => `/repos/o/r${suffix}`,
    paginate: async () => [canonicalComment],
    request: async (method, path, options = {}) => {
      if (path === "/repos/o/r") return { status: 200, data: { default_branch: "main" } };
      if (path.endsWith("/pulls/34")) return { status: 200, data: livePull({ draft: false }) };
      if (method === "PATCH" && path.endsWith("/issues/comments/5")) canonicalBody = options.body.body;
      return { status: 200, data: { id: 5, html_url: "https://example.test/comment/5" } };
    },
  };
  await publish(fake, "ready", {
    issue: 12,
    pr: 34,
    state: passingState({ problems: [] }),
    review: { verdict: "pass", reviewed_sha: "a".repeat(40), findings: [] },
    evaluation: { all_ok: true },
  });
  const updated = parseStateComment(canonicalBody);
  assert.equal(updated.problems.length, 1);
  assert.equal(updated.problems[0].id, "P-041");
});

test("state publisher records a no-change blocker on both Issue and existing PR", async () => {
  let prBody = "";
  const labeled = [];
  const fake = {
    appId: "123",
    botLogin: "",
    repoPath: (suffix) => `/repos/o/r${suffix}`,
    paginate: async () => [],
    request: async (method, path, options = {}) => {
      if (method === "POST" && path.endsWith("/labels") && path.includes("/issues/")) labeled.push(path);
      if (method === "POST" && path.endsWith("/issues/34/comments")) prBody = options.body.body;
      return { status: method === "GET" ? 200 : 201, data: { id: 9, html_url: "https://example.test/comment/9" } };
    },
  };
  const blocker = passingState({
    phase: "human_required",
    problems: [
      { id: "P-700000001", problem: "No publishable change", risk: "low", status: "HUMAN_REQUIRED", evidence: "Already fixed", owner: null, next_step: "Maintainer decision" },
    ],
  });
  const result = await publish(fake, "state", { issue: 12, pr: 34, state: blocker, body: "No change was produced." });
  assert.equal(result.pr, 34);
  assert.equal(labeled.some((path) => path.endsWith("/issues/12/labels")), true);
  assert.equal(labeled.some((path) => path.endsWith("/issues/34/labels")), true);
  assert.match(prBody, /No change was produced/);
  assert.match(prBody, /Agent 진행 현황/);
});

test("PR publisher refreshes the body when reusing an existing branch PR", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pipeline-publish-pr-"));
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });
  let refreshedBody = "";
  const fake = {
    appId: "123",
    botLogin: "",
    token: "test-token",
    repository: "o/r",
    graphqlUrl: "https://api.example.test/graphql",
    repoPath: (suffix) => `/repos/o/r${suffix}`,
    paginate: async () => [],
    request: async (method, path, options = {}) => {
      if (method === "GET" && path === "/repos/o/r") return { status: 200, data: { default_branch: "main" } };
      if (method === "GET" && path.endsWith("/pulls/34")) return { status: 200, data: livePull() };
      if (method === "PATCH" && path.endsWith("/pulls/34")) {
        refreshedBody = options.body.body;
        return { status: 200, data: { number: 34, html_url: "https://example.test/pull/34" } };
      }
      if (path.endsWith("/requested_reviewers")) return { status: 201, data: {} };
      return { status: 201, data: { id: 9, html_url: "https://example.test/comment/9" } };
    },
  };
  const result = await publish(fake, "pr", {
    issue: 12,
    branch: "agent/issue-12-session",
    base: "main",
    repo,
    push: false,
    reviewer: "frontend-owner",
    changed_paths: ["src/second-iteration.ts"],
    state: passingState({ plan: { risk: "low", steps: ["Apply second iteration fix"] } }),
  });
  assert.equal(result.reused, true);
  assert.match(refreshedBody, /Apply second iteration fix/);
  assert.match(refreshedBody, /src\/second-iteration\.ts/);
});

test("review publication preserves prior unresolved problems by stable ID", async () => {
  const prior = passingState({
    problems: [
      { id: "P-007", problem: "Persisted finding", risk: "high", status: "HUMAN_REQUIRED", evidence: "src/auth/x.ts:9", owner: "platform-maintainer", next_step: "Human review" },
    ],
  });
  let patchedBody = "";
  const fake = {
    appId: "123",
    botLogin: "",
    repoPath: (suffix) => `/repos/o/r${suffix}`,
    paginate: async () => [
      { id: 5, updated_at: "2026-01-01T00:00:00Z", performed_via_github_app: { id: 123 }, body: renderProgress(prior) },
    ],
    request: async (method, path, options = {}) => {
      if (method === "PATCH" && path.endsWith("/issues/comments/5")) patchedBody = options.body.body;
      return { status: 200, data: { id: 5, html_url: "https://example.test/comment/5" } };
    },
  };
  await publish(fake, "review", {
    issue: 12,
    pr: 34,
    state: prior,
    review: { verdict: "pass", reviewed_sha: "a".repeat(40), findings: [] },
  });
  const updated = parseStateComment(patchedBody);
  assert.equal(updated.problems.length, 1);
  assert.equal(updated.problems[0].id, "P-007");
  assert.equal(updated.problems[0].status, "HUMAN_REQUIRED");
});

test("review publication persists deterministic human-required evaluation", async () => {
  const prior = passingState({ reviewer: "frontend-owner", protected_paths: { passed: false, matched: ["CODEOWNERS"] } });
  let patchedBody = "";
  let humanLabel = false;
  const fake = {
    appId: "123",
    botLogin: "",
    repoPath: (suffix) => `/repos/o/r${suffix}`,
    paginate: async () => [
      { id: 5, updated_at: "2026-01-01T00:00:00Z", performed_via_github_app: { id: 123 }, body: renderProgress(prior) },
    ],
    request: async (method, path, options = {}) => {
      if (method === "POST" && path.endsWith("/issues/34/labels")) humanLabel = options.body.labels.includes("agent:human-required");
      if (method === "PATCH" && path.endsWith("/issues/comments/5")) patchedBody = options.body.body;
      return { status: 200, data: { id: 5, html_url: "https://example.test/comment/5" } };
    },
  };
  const result = await publish(fake, "review", {
    issue: 12,
    pr: 34,
    state: prior,
    reviewer: "frontend-owner",
    review: { verdict: "pass", reviewed_sha: "a".repeat(40), findings: [] },
    evaluation: { all_ok: false, human_required: true, next_phase: "human_required", max_iterations_reached: true },
  });
  assert.equal(result.human_required, true);
  assert.equal(result.phase, "human_required");
  assert.equal(humanLabel, true);
  assert.equal(parseStateComment(patchedBody).phase, "human_required");
});

test("reviewer API rejection sets canonical HUMAN_REQUIRED and posts full progress", async () => {
  const prior = passingState({ reviewer: "frontend-owner", problems: [] });
  let patchedBody = "";
  let summaryBody = "";
  let humanLabel = false;
  const fake = {
    appId: "123",
    botLogin: "",
    repoPath: (suffix) => `/repos/o/r${suffix}`,
    paginate: async () => [
      { id: 5, updated_at: "2026-01-01T00:00:00Z", performed_via_github_app: { id: 123 }, body: renderProgress(prior) },
    ],
    request: async (method, path, options = {}) => {
      if (path.endsWith("/requested_reviewers")) return { status: 422, data: { message: "not available" } };
      if (path.endsWith("/labels")) humanLabel = options.body.labels.includes("agent:human-required");
      if (method === "PATCH" && path.endsWith("/issues/comments/5")) patchedBody = options.body.body;
      if (method === "POST" && path.endsWith("/issues/34/comments")) summaryBody = options.body.body;
      return { status: 200, data: { id: 5, html_url: "https://example.test/comment/5" } };
    },
  };
  const result = await publish(fake, "review", {
    issue: 12,
    pr: 34,
    state: prior,
    review: { verdict: "pass", reviewed_sha: "a".repeat(40), findings: [] },
    fallback_mention: "@platform-maintainer",
  });
  assert.equal(result.human_required, true);
  assert.equal(humanLabel, true);
  assert.equal(parseStateComment(patchedBody).phase, "human_required");
  assert.match(summaryBody, /Agent 진행 현황/);
  assert.match(summaryBody, /@platform-maintainer/);
});

test("CLI writes normalized JSON to --output", () => {
  const directory = mkdtempSync(join(tmpdir(), "pipeline-cli-"));
  const input = join(directory, "review.raw.json");
  const output = join(directory, "review.json");
  writeFileSync(input, JSON.stringify({ result: { verdict: "pass", reviewed_sha: "a".repeat(40), findings: [] } }));
  execFileSync(process.execPath, [pipelinePath, "normalize-agent-output", "--kind", "review", "--input", input, "--output", output]);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).verdict, "pass");
});

test("repository team.yaml protects its own governing policy documents", () => {
  const repoTeam = loadTeam(fileURLToPath(new URL("../team.yaml", import.meta.url)));
  const result = checkProtectedPaths(repoTeam, ["docs/git-ground-rules.md", "AGENTS.md", "CLAUDE.md"], false);
  assert.deepEqual(result.matched.sort(), ["AGENTS.md", "CLAUDE.md", "docs/git-ground-rules.md"]);
  // Every configured issue/PR assignee cap must actually flow through selectOwner/selectPrTeam.
  assert.equal(asIntegerFromTeam(repoTeam, "max_issue_assignees"), selectOwner(repoTeam, { title: "", body: "" }).max_assignees);
});

function assertSchemaShape(value, schema, path = "$") {
  if (value === null) return;
  if (isPlainObject(schema.properties) && schema.additionalProperties === false) {
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${path} must be an object`);
    assert.deepEqual(
      Object.keys(value).sort(),
      Object.keys(schema.properties).sort(),
      `${path} keys must match schemas/state.schema.json`,
    );
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      assertSchemaShape(value[key], propertySchema, `${path}.${key}`);
    }
    return;
  }
  if (schema.type === "array" && schema.items) {
    assert.ok(Array.isArray(value), `${path} must be an array`);
    value.forEach((item, index) => assertSchemaShape(item, schema.items, `${path}[${index}]`));
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asIntegerFromTeam(repoTeam, key) {
  const value = repoTeam.pipeline?.[key];
  return typeof value === "number" ? value : 1;
}

test("canonical state shape stays in sync with schemas/state.schema.json", () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/state.schema.json", import.meta.url)), "utf8"));
  const sampleState = initialState({
    issue: 1,
    branch: "agent/issue-1-sample",
    pr: 2,
    assignee: "platform-maintainer",
    reviewer: "frontend-owner",
    agent: "codex",
    plan: { risk: "low" },
    reviewed_sha: "a".repeat(40),
    current_sha: "b".repeat(40),
    problems: [{ id: "P-001", problem: "x", risk: "low", status: "OPEN", evidence: "e", owner: null, next_step: "n" }],
    validation: { passed: true, commands: [{ command: "npm test", passed: true, exit_code: 0 }] },
    protected_paths: { passed: true, matched: [], content_approved_by: "frontend-owner", content_approved_sha: "c".repeat(40) },
  });
  assert.deepEqual(Object.keys(sampleState).sort(), Object.keys(schema.properties).sort());
  assertSchemaShape(sampleState, schema);
});
