#!/usr/bin/env node

/**
 * Deterministic controller for the issue -> draft PR -> review pipeline.
 *
 * The model produces data and patches. This program owns policy decisions and
 * GitHub writes. It deliberately has no third-party runtime dependencies so it
 * can run in a freshly checked-out repository with Node 20.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, normalize, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIPELINE_VERSION = 1;
const STATE_MARKER = "issue-review-state:v1";
const PROTECTED_REQUEST_MARKER = "agent-protected-request:v1";
const PROTECTED_APPROVAL_PREFIX = "/agent approve-protected ";
const PROTECTED_CONTENT_PROBLEM_ID = "P-700000002";
const WRITE_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const MANAGED_LABELS = {
  "agent:approval-required": { color: "fbca04", description: "Maintainer approval is required before agent intake" },
  "agent:human-required": { color: "d93f0b", description: "Automation is paused for an eligible human reviewer" },
  "agent:split-required": { color: "5319e7", description: "The change must be decomposed into multiple semantic PR units" },
  "agent:done": { color: "0e8a16", description: "Agent checks passed; human review remains authoritative" },
};
const PROBLEM_STATUSES = new Set([
  "OPEN",
  "PLANNED",
  "IN_PROGRESS",
  "FIXED",
  "REVIEW_PENDING",
  "HUMAN_REQUIRED",
  "DONE",
]);
const RISK_CATEGORY_IDS = [
  "access_control",
  "sensitive_information_exposure",
  "application_security",
  "security_configuration",
  "data_integrity",
  "data_loss",
  "data_compatibility",
  "data_governance",
  "service_availability",
  "performance_capacity",
  "dependency_resilience",
  "deployment_recovery",
  "operational_visibility",
  "equivalent_severity",
];
const RISK_IMPACTS = ["negligible", "limited", "material", "severe", "unknown"];
const RISK_LIKELIHOODS = ["unlikely", "possible", "likely", "unknown"];
const RISK_BLAST_RADII = ["local", "contained", "broad", "unknown"];
const RISK_REVERSIBILITY = ["easy", "managed", "difficult", "irreversible", "unknown"];
const RISK_DETECTABILITY = ["strong", "adequate", "weak", "unknown"];

export class PipelineError extends Error {
  constructor(message, code = "PIPELINE_ERROR", details = undefined) {
    super(message);
    this.name = "PipelineError";
    this.code = code;
    this.details = details;
  }
}

function invariant(condition, message, code, details) {
  if (!condition) throw new PipelineError(message, code, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function asInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ""))];
}

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeRepoPath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

function normalizeRisk(value, unknownIsHigh = true) {
  const risk = lower(value);
  if (risk === "low") return "low";
  if (risk === "high") return "high";
  return unknownIsHigh ? "high" : "unknown";
}

function canonicalStatus(value, fallback = "OPEN") {
  const status = String(value ?? fallback).trim().toUpperCase();
  if (status === "FIXING") return "IN_PROGRESS";
  return PROBLEM_STATUSES.has(status) ? status : fallback;
}

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function stableStringify(value, spacing = 2) {
  return JSON.stringify(stableValue(value), null, spacing);
}

function stripYamlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (char === "#" && !quote && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line.trimEnd();
}

function yamlScalar(source) {
  const value = source.trim();
  if (value === "") return undefined;
  if (value === "null" || value === "~") return null;
  if (/^(true|false)$/i.test(value)) return lower(value) === "true";
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    try {
      return JSON.parse(value.replace(/'([^']*)'/g, (_, text) => JSON.stringify(text)));
    } catch {
      // Keep uncommon YAML flow syntax as a string rather than guessing.
    }
  }
  return value;
}

function splitYamlKeyValue(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if ((char === '"' || char === "'") && (!quote || quote === char)) quote = quote ? null : char;
    if (char === ":" && !quote && (index + 1 === text.length || /\s/.test(text[index + 1]))) {
      return [text.slice(0, index).trim(), text.slice(index + 1).trim()];
    }
  }
  return null;
}

/** A deliberately small, strict YAML subset parser for the repository policy. */
export function parseYaml(source) {
  const lines = String(source)
    .split(/\r?\n/)
    .map((raw, lineNumber) => {
      invariant(!raw.includes("\t"), `Tabs are not allowed in policy YAML (line ${lineNumber + 1})`, "INVALID_YAML");
      const clean = stripYamlComment(raw);
      return { indent: clean.match(/^ */)[0].length, text: clean.trim(), lineNumber: lineNumber + 1 };
    })
    .filter((line) => line.text && line.text !== "---" && line.text !== "...");

  function parseBlock(start, indent) {
    invariant(start < lines.length, "Unexpected end of YAML", "INVALID_YAML");
    const sequence = lines[start].text === "-" || lines[start].text.startsWith("- ");
    const result = sequence ? [] : {};
    let index = start;

    while (index < lines.length) {
      const line = lines[index];
      if (line.indent < indent) break;
      invariant(line.indent === indent, `Unexpected indentation on line ${line.lineNumber}`, "INVALID_YAML");
      const isSequenceLine = line.text === "-" || line.text.startsWith("- ");
      invariant(isSequenceLine === sequence, `Mixed mapping and sequence on line ${line.lineNumber}`, "INVALID_YAML");

      if (sequence) {
        const itemText = line.text === "-" ? "" : line.text.slice(2).trim();
        if (!itemText) {
          invariant(index + 1 < lines.length && lines[index + 1].indent > indent, `Missing sequence value on line ${line.lineNumber}`, "INVALID_YAML");
          const child = parseBlock(index + 1, lines[index + 1].indent);
          result.push(child.value);
          index = child.index;
          continue;
        }

        const pair = splitYamlKeyValue(itemText);
        if (!pair) {
          result.push(yamlScalar(itemText));
          index += 1;
          continue;
        }

        const [rawKey, rawValue] = pair;
        const item = {};
        const key = String(yamlScalar(rawKey));
        index += 1;
        if (rawValue !== "") item[key] = yamlScalar(rawValue);
        else if (index < lines.length && lines[index].indent > indent) {
          const child = parseBlock(index, lines[index].indent);
          item[key] = child.value;
          index = child.index;
        } else item[key] = null;

        if (index < lines.length && lines[index].indent > indent) {
          const continuation = parseBlock(index, lines[index].indent);
          invariant(isObject(continuation.value), `Sequence mapping expected on line ${lines[index].lineNumber}`, "INVALID_YAML");
          Object.assign(item, continuation.value);
          index = continuation.index;
        }
        result.push(item);
        continue;
      }

      const pair = splitYamlKeyValue(line.text);
      invariant(pair, `Expected key/value pair on line ${line.lineNumber}`, "INVALID_YAML");
      const [rawKey, rawValue] = pair;
      const key = String(yamlScalar(rawKey));
      invariant(!(key in result), `Duplicate YAML key '${key}' on line ${line.lineNumber}`, "INVALID_YAML");
      index += 1;
      if (rawValue !== "") result[key] = yamlScalar(rawValue);
      else if (index < lines.length && lines[index].indent > indent) {
        const child = parseBlock(index, lines[index].indent);
        result[key] = child.value;
        index = child.index;
      } else result[key] = null;
    }
    return { value: result, index };
  }

  return lines.length ? parseBlock(0, lines[0].indent).value : {};
}

export function loadTeam(teamPath = ".github/agent-pipeline/team.yaml") {
  invariant(existsSync(teamPath), `Team policy not found: ${teamPath}`, "MISSING_TEAM_POLICY");
  const team = parseYaml(readFileSync(teamPath, "utf8"));
  invariant(team.version === PIPELINE_VERSION, `Unsupported team policy version: ${team.version}`, "INVALID_TEAM_POLICY");
  invariant(isObject(team.pipeline), "team.yaml must define pipeline", "INVALID_TEAM_POLICY");
  invariant(Array.isArray(team.people), "team.yaml must define people[]", "INVALID_TEAM_POLICY");
  const changeScope = team.pipeline.change_scope;
  invariant(isObject(changeScope), "team.yaml must define pipeline.change_scope", "INVALID_TEAM_POLICY");
  invariant(changeScope.commit_unit === "single_crud_bundle", "change_scope.commit_unit must be single_crud_bundle", "INVALID_TEAM_POLICY");
  invariant(changeScope.pr_unit === "single_semantic_unit", "change_scope.pr_unit must be single_semantic_unit", "INVALID_TEAM_POLICY");
  const target = asInteger(changeScope.target_pr_changed_lines, 0);
  const maximum = asInteger(changeScope.max_pr_changed_lines, 0);
  invariant(target > 0 && maximum >= target, "change_scope line limits must be positive and ordered", "INVALID_TEAM_POLICY");
  const riskPolicy = team.pipeline.risk_policy;
  invariant(isObject(riskPolicy) && riskPolicy.equivalent_severity_is_high === true, "risk_policy must fail high for equivalent severity", "INVALID_TEAM_POLICY");
  invariant(Array.isArray(riskPolicy.categories), "risk_policy must define categories[]", "INVALID_TEAM_POLICY");
  const categoryIds = riskPolicy.categories.map((category) => String(category?.id ?? ""));
  invariant(new Set(categoryIds).size === categoryIds.length, "risk_policy category IDs must be unique", "INVALID_TEAM_POLICY");
  for (const categoryId of RISK_CATEGORY_IDS.filter((id) => id !== "equivalent_severity")) {
    const category = riskPolicy.categories.find((candidate) => candidate?.id === categoryId);
    invariant(category && asArray(category.signals).length > 0, `risk_policy category ${categoryId} needs signals`, "INVALID_TEAM_POLICY");
    invariant(asArray(category.high_impact_signals).length > 0, `risk_policy category ${categoryId} needs high_impact_signals`, "INVALID_TEAM_POLICY");
  }
  const logins = new Set();
  for (const person of team.people) {
    invariant(person?.github, "Every person needs a github login", "INVALID_TEAM_POLICY");
    invariant(!logins.has(lower(person.github)), `Duplicate person: ${person.github}`, "INVALID_TEAM_POLICY");
    logins.add(lower(person.github));
  }
  return team;
}

function globSegment(segment) {
  let result = "";
  for (const char of segment) {
    if (char === "*") result += "[^/]*";
    else if (char === "?") result += "[^/]";
    else result += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return result;
}

export function globToRegExp(pattern) {
  const normalized = normalizeRepoPath(pattern);
  const segments = normalized.split("/");
  let source = "^";
  segments.forEach((segment, index) => {
    if (segment === "**") {
      source += index === segments.length - 1 ? ".*" : "(?:[^/]+/)*";
    } else {
      source += globSegment(segment);
      if (index < segments.length - 1) source += "/";
    }
  });
  return new RegExp(`${source}$`);
}

export function matchesGlob(filePath, pattern) {
  return globToRegExp(pattern).test(normalizeRepoPath(filePath));
}

function matchingPatterns(paths, patterns) {
  return unique(paths.flatMap((filePath) => patterns.filter((pattern) => matchesGlob(filePath, pattern)).map((pattern) => `${filePath}:${pattern}`)));
}

function protectedPathList(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return { valid: false, paths: [], reason: "paths_must_be_a_non_empty_array" };
  }
  const paths = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") return { valid: false, paths: [], reason: "path_must_be_a_string" };
    const filePath = candidate;
    const segments = filePath.split("/");
    if (
      filePath !== filePath.trim() ||
      filePath.length === 0 ||
      filePath.length > 4096 ||
      filePath.startsWith("/") ||
      filePath.startsWith("./") ||
      filePath.endsWith("/") ||
      filePath.includes("\\") ||
      filePath.includes("//") ||
      /[\0-\x1f\x7f*?[\]{}!]/.test(filePath) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
      posix.normalize(filePath) !== filePath ||
      normalizeRepoPath(filePath) !== filePath
    ) {
      return { valid: false, paths: [], reason: `invalid_exact_repo_path:${filePath}` };
    }
    paths.push(filePath);
  }
  if (new Set(paths).size !== paths.length) return { valid: false, paths: [], reason: "paths_must_be_unique" };
  return { valid: true, paths, reason: "valid" };
}

function exactObjectKeys(value, keys) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Parses the only accepted machine-readable protected-path request marker. */
export function parseProtectedRequest(issueInput) {
  const issue = issueInput?.issue ?? issueInput ?? {};
  const body = String(issue?.body ?? "");
  const occurrenceCount = body.split(PROTECTED_REQUEST_MARKER).length - 1;
  if (occurrenceCount === 0) return { present: false, valid: true, paths: [], reason: "not_requested" };
  if (occurrenceCount !== 1) return { present: true, valid: false, paths: [], reason: "duplicate_request_marker" };

  const pattern = /<!-- agent-protected-request:v1 (\{[^\r\n]*\}) -->/g;
  const matches = [...body.matchAll(pattern)];
  if (matches.length !== 1) return { present: true, valid: false, paths: [], reason: "malformed_request_marker" };
  let payload;
  try {
    payload = JSON.parse(matches[0][1]);
  } catch {
    return { present: true, valid: false, paths: [], reason: "invalid_request_json" };
  }
  if (!exactObjectKeys(payload, ["paths"])) return { present: true, valid: false, paths: [], reason: "invalid_request_schema" };
  const parsed = protectedPathList(payload.paths);
  return parsed.valid
    ? { present: true, valid: true, paths: parsed.paths, reason: "valid" }
    : { present: true, valid: false, paths: [], reason: parsed.reason };
}

/** Parses a complete protected-path approval comment; surrounding prose is rejected. */
export function parseProtectedApprovalCommand(bodyInput) {
  const body = String(bodyInput ?? "");
  const present = body.includes(PROTECTED_APPROVAL_PREFIX.trim());
  if (!present) return { present: false, valid: false, issue: null, paths: [], reason: "not_approval_command" };
  if (body !== body.trim() || body.includes("\n") || body.includes("\r") || !body.startsWith(PROTECTED_APPROVAL_PREFIX)) {
    return { present: true, valid: false, issue: null, paths: [], reason: "malformed_approval_command" };
  }
  let payload;
  try {
    payload = JSON.parse(body.slice(PROTECTED_APPROVAL_PREFIX.length));
  } catch {
    return { present: true, valid: false, issue: null, paths: [], reason: "invalid_approval_json" };
  }
  if (!exactObjectKeys(payload, ["issue", "paths"]) || !Number.isInteger(payload.issue) || payload.issue < 1) {
    return { present: true, valid: false, issue: null, paths: [], reason: "invalid_approval_schema" };
  }
  const parsed = protectedPathList(payload.paths);
  return parsed.valid
    ? { present: true, valid: true, issue: payload.issue, paths: parsed.paths, reason: "valid" }
    : { present: true, valid: false, issue: payload.issue, paths: [], reason: parsed.reason };
}

function samePathSet(left, right) {
  const leftPaths = [...left].sort();
  const rightPaths = [...right].sort();
  return leftPaths.length === rightPaths.length && leftPaths.every((filePath, index) => filePath === rightPaths[index]);
}

function readJsonish(input, label = "input") {
  if (input === undefined || input === null) return {};
  if (typeof input !== "string") return deepClone(input);
  const source = input === "-" ? readFileSync(0, "utf8") : readFileSync(input, "utf8");
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new PipelineError(`Invalid JSON in ${label}: ${error.message}`, "INVALID_JSON");
  }
}

function readPaths(input) {
  if (input === undefined || input === null) return [];
  if (Array.isArray(input)) return unique(input.map(normalizeRepoPath));
  if (isObject(input)) {
    return readPaths(input.changed_paths ?? input.changed_files ?? input.paths ?? []);
  }
  if (typeof input === "string" && existsSync(input)) {
    const raw = readFileSync(input, "utf8").trim();
    if (!raw) return [];
    try {
      return readPaths(JSON.parse(raw));
    } catch {
      return unique(raw.split(/\0|\r?\n/).map(normalizeRepoPath));
    }
  }
  return unique(String(input).split(",").map(normalizeRepoPath));
}

/** Converts git's NUL-delimited path output into a lossless JSON-ready list. */
export function pathsFromNul(source) {
  return unique(String(source).split("\0").filter(Boolean).map(normalizeRepoPath));
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      args._.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    const key = (equal >= 0 ? token.slice(2, equal) : token.slice(2)).replaceAll("-", "_");
    let value;
    if (equal >= 0) value = token.slice(equal + 1);
    else if (index + 1 < argv.length && !argv[index + 1].startsWith("--")) value = argv[++index];
    else value = true;
    if (key in args) args[key] = asArray(args[key]).concat(value);
    else args[key] = value;
  }
  return args;
}

function eventLabels(issue) {
  return asArray(issue?.labels).map((label) => lower(isObject(label) ? label.name : label));
}

function actorIsBot(event) {
  const user = event.comment?.user ?? event.review?.user ?? event.sender ?? event.issue?.user ?? event.pull_request?.user;
  return lower(user?.type) === "bot" || /\[bot\]$/i.test(String(user?.login ?? ""));
}

function sourceIssueFromPullRequest(pr) {
  const branch = String(pr?.head?.ref ?? "");
  const branchMatch = branch.match(/^agent\/issue-(\d+)(?:-|$)/);
  if (branchMatch) return Number(branchMatch[1]);
  const bodyMatch = String(pr?.body ?? "").match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i);
  return bodyMatch ? Number(bodyMatch[1]) : null;
}

function pullRequestIsSafe(pr, branchPrefix, defaultBranch, repositoryFullName) {
  const headRepo = pr?.head?.repo?.full_name;
  const baseRepo = pr?.base?.repo?.full_name;
  const expectedBase = String(defaultBranch ?? "");
  const expectedRepository = String(repositoryFullName ?? "");
  return Boolean(
    headRepo &&
      baseRepo &&
      lower(pr?.state) === "open" &&
      pr?.merged !== true &&
      headRepo === baseRepo &&
      (!expectedRepository || (headRepo === expectedRepository && baseRepo === expectedRepository)) &&
      String(pr?.head?.ref ?? "").startsWith(branchPrefix) &&
      (!expectedBase || String(pr?.base?.ref ?? "") === expectedBase),
  );
}

/** Deterministically decides whether an Actions event may enter the pipeline. */
export function gateEvent(event, eventName, team, options = {}) {
  const pipeline = team.pipeline ?? {};
  const name = String(eventName ?? event?.event_name ?? "");
  const defaultBranch = String(event?.repository?.default_branch ?? "");
  const action = String(event?.action ?? "");
  const issue = event?.issue;
  const pr = event?.pull_request ?? (issue?.pull_request ? event?.pull_request : null);
  const association = String(
    event?.comment?.author_association ??
      event?.review?.author_association ??
      issue?.author_association ??
      pr?.author_association ??
      event?.sender?.author_association ??
      "NONE",
  ).toUpperCase();
  const dispatchedPr = asInteger(options.dispatch_pr, 0) || null;
  const dispatchedIssue = asInteger(options.dispatch_issue, 0) || null;
  const sourceIssue = pr ? sourceIssueFromPullRequest(pr) ?? dispatchedIssue : asInteger(options.source_issue_number, issue?.number ?? dispatchedIssue ?? 0) || null;
  const issueNumber = issue?.number ?? sourceIssue ?? dispatchedIssue ?? null;
  const prNumber = pr?.number ?? dispatchedPr ?? (issue?.pull_request ? issue?.number : null);
  const branch = pr?.head?.ref ?? (issueNumber ? branchName(team, issueNumber, issue?.title ?? "work") : "");
  const base = {
    allowed: false,
    proceed: false,
    reason: "unsupported_event",
    event_name: name,
    action,
    event_action: action,
    phase: "ignored",
    issue_number: issueNumber,
    pr_number: prNumber,
    source_issue_number: sourceIssue,
    checkout_ref: pr?.head?.sha ?? pr?.head?.ref ?? event?.repository?.default_branch ?? "",
    branch,
    iteration: asInteger(options.iteration, 0),
    head_sha: pr?.head?.sha ?? event?.after ?? "",
    base_sha: pr?.base?.sha ?? "",
    base_ref: pr?.base?.ref ?? event?.repository?.default_branch ?? "",
    author_association: association,
    concurrency_key: `issue-review-${sourceIssue ?? issueNumber ?? prNumber ?? "manual"}`,
    approval_required: false,
    write_safe: false,
  };
  const allow = (phase, reason = "allowed") => ({ ...base, allowed: true, proceed: true, reason, action: phase, phase, write_safe: true });
  const deny = (reason, extra = {}) => ({ ...base, reason, ...extra });

  if (name === "pull_request_target") return deny("pull_request_target_is_forbidden");
  // App-token pushes legitimately emit pull_request.synchronize as a bot. Bot
  // authored conversational events are ignored to prevent feedback loops.
  if (name !== "pull_request" && actorIsBot(event)) return deny("bot_event_ignored");

  if (name === "issues") {
    if (action === "labeled") {
      const label = lower(event?.label?.name);
      if (label !== "agent:approved") return deny("unrelated_issue_label");
      return allow("triage", "maintainer_approved");
    }
    if (action !== "opened") return deny("unsupported_issue_action");
    if (WRITE_ASSOCIATIONS.has(association) || eventLabels(issue).includes("agent:approved")) return allow("intake");
    return deny("external_author_requires_approval", { approval_required: true, action: "approval-required", phase: "human_approval" });
  }

  if (name === "pull_request") {
    if (!["opened", "synchronize", "reopened"].includes(action)) return deny("unsupported_pull_request_action");
    if (!pullRequestIsSafe(pr, pipeline.branch_prefix ?? "agent/issue-", defaultBranch, event?.repository?.full_name)) {
      return deny("fork_non_agent_or_non_default_base");
    }
    return allow("review");
  }

  if (name === "pull_request_review" || name === "pull_request_review_comment") {
    const expectedAction = name === "pull_request_review" ? "submitted" : "created";
    if (action !== expectedAction) return deny(`unsupported_${name}_action`);
    if (!pullRequestIsSafe(pr, pipeline.branch_prefix ?? "agent/issue-", defaultBranch, event?.repository?.full_name)) {
      return deny("fork_non_agent_or_non_default_base");
    }
    if (!WRITE_ASSOCIATIONS.has(association)) return deny("review_activity_requires_write_access");
    return allow("review", "human_review_activity");
  }

  if (name === "issue_comment") {
    if (action !== "created") return deny("unsupported_issue_comment_action");
    const commentBody = String(event?.comment?.body ?? "");
    const protectedApproval = parseProtectedApprovalCommand(commentBody);
    const resume = /^\s*\/agent\s+resume\s*$/i.test(commentBody);
    if (!resume && !protectedApproval.present) return deny("not_resume_or_protected_approval_command");
    if (!WRITE_ASSOCIATIONS.has(association)) return deny(resume ? "resume_requires_write_access" : "protected_approval_requires_write_access");
    if (protectedApproval.present) {
      if (!protectedApproval.valid) return deny(protectedApproval.reason);
      if (issue?.pull_request) return deny("protected_approval_must_be_on_source_issue");
      if (protectedApproval.issue !== asInteger(issue?.number, 0)) return deny("protected_approval_issue_mismatch");
      return allow("triage", "protected_scope_approval_submitted");
    }
    if (issue?.pull_request || pr) {
      if (!pr) return deny("pr_resume_requires_enriched_pull_request");
      if (!pullRequestIsSafe(pr, pipeline.branch_prefix ?? "agent/issue-", defaultBranch, event?.repository?.full_name)) {
        return deny("fork_non_agent_or_non_default_base");
      }
    }
    return allow("resume", "maintainer_resume");
  }

  if (name === "workflow_dispatch") {
    if (!issueNumber && !prNumber) return deny("manual_dispatch_requires_issue_or_pr");
    if (pr && !pullRequestIsSafe(pr, pipeline.branch_prefix ?? "agent/issue-", defaultBranch, event?.repository?.full_name)) {
      return deny("fork_non_agent_or_non_default_base");
    }
    if (pr && dispatchedIssue && sourceIssue !== dispatchedIssue) return deny("dispatch_issue_pr_mismatch");
    const requestedPhase = lower(options.dispatch_phase);
    return allow(["triage", "review"].includes(requestedPhase) ? requestedPhase : "dispatch", "manual_dispatch");
  }
  return deny("unsupported_event");
}

function issueText(issueOrEvent) {
  const issue = issueOrEvent?.issue ?? issueOrEvent;
  return `${issue?.title ?? ""}\n${issue?.body ?? ""}`.toLowerCase();
}

function hasTerm(text, term) {
  const needle = lower(term);
  if (!needle) return false;
  if (/^[a-z0-9_-]+$/i.test(needle)) return new RegExp(`(^|[^a-z0-9_-])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_-]|$)`, "i").test(text);
  return text.includes(needle);
}

export function selectOwner(team, issueOrEvent) {
  const text = issueText(issueOrEvent);
  const labels = new Set(eventLabels(issueOrEvent?.issue ?? issueOrEvent));
  const fallback = lower(team.pipeline?.fallback_assignee);
  const candidates = team.people
    .filter((person) => person.active !== false)
    .map((person, index) => {
      const responsibilities = person.responsibilities ?? {};
      const matchedLabels = asArray(responsibilities.labels).filter((label) => labels.has(lower(label)));
      const matchedDomains = asArray(responsibilities.domains).filter((domain) => hasTerm(text, domain) || labels.has(`area/${lower(domain)}`));
      const matchedKeywords = asArray(responsibilities.keywords).filter((keyword) => hasTerm(text, keyword));
      const breakdown = {
        label: matchedLabels.length ? 40 : 0,
        domain: matchedDomains.length ? 30 : 0,
        keyword: matchedKeywords.length ? 20 : 0,
        fallback: lower(person.github) === fallback ? 10 : 0,
      };
      return {
        github: person.github,
        agent: person.main_agent ?? team.pipeline?.bootstrap_agent,
        score: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
        breakdown,
        matched_labels: matchedLabels,
        matched_domains: matchedDomains,
        matched_keywords: matchedKeywords,
        _index: index,
      };
    })
    .sort((left, right) => right.score - left.score || left._index - right._index || left.github.localeCompare(right.github));
  let selected = candidates[0];
  let usedFallback = false;
  if (!selected || selected.score < 30) {
    selected = candidates.find((candidate) => lower(candidate.github) === fallback);
    usedFallback = true;
  }
  invariant(selected, "No active fallback assignee is available", "NO_ASSIGNEE");
  const cleanCandidates = candidates.map(({ _index, ...candidate }) => candidate);
  const { _index, ...cleanSelected } = selected;
  return {
    assignee: selected.github,
    agent: selected.agent ?? team.pipeline?.bootstrap_agent,
    score: selected.score,
    used_fallback: usedFallback,
    rationale: usedFallback ? "No candidate met the minimum score of 30" : "Highest deterministic R&R score",
    max_assignees: asInteger(team.pipeline?.max_issue_assignees, 1),
    selected: cleanSelected,
    candidates: cleanCandidates,
  };
}

export function routeAgent(team, assignee) {
  const person = team.people.find((candidate) => lower(candidate.github) === lower(assignee) && candidate.active !== false);
  const agent = person?.main_agent ?? team.pipeline?.bootstrap_agent;
  invariant(agent, "No bootstrap agent is configured", "NO_AGENT");
  return { assignee: person?.github ?? assignee ?? null, agent, source: person?.main_agent ? "assignee" : "bootstrap" };
}

function domainMatchesPerson(person, domains) {
  const owned = new Set(asArray(person.responsibilities?.domains).map(lower));
  return domains.some((domain) => owned.has(lower(domain)));
}

function contributionScores(codegraph, paths) {
  const pathSet = new Set(paths.map(normalizeRepoPath));
  const blame = new Map();
  const recent = new Map();
  for (const edge of asArray(codegraph?.edges)) {
    const fileId = edge.to?.startsWith("file:") ? edge.to.slice(5) : edge.from?.startsWith("file:") ? edge.from.slice(5) : null;
    if (!fileId || !pathSet.has(normalizeRepoPath(fileId))) continue;
    const personId = edge.from?.startsWith("person:") ? edge.from.slice(7) : edge.to?.startsWith("person:") ? edge.to.slice(7) : null;
    const login = edge.github ?? personId;
    if (!login) continue;
    if (edge.type === "blame") blame.set(lower(login), (blame.get(lower(login)) ?? 0) + Number(edge.weight ?? edge.lines ?? 1));
    if (edge.type === "recent_commit") recent.set(lower(login), (recent.get(lower(login)) ?? 0) + Number(edge.weight ?? 1));
  }
  const maxBlame = Math.max(0, ...blame.values());
  const maxRecent = Math.max(0, ...recent.values());
  return { blame, recent, maxBlame, maxRecent };
}

export function selectPrTeam(team, input = {}) {
  const paths = readPaths(input.changed_paths ?? input.changed_files ?? input.paths);
  const domains = asArray(input.domains).map(lower);
  const issueAssignee = lower(input.issue_assignee);
  const author = lower(input.author);
  const implementer = lower(input.implementer);
  const risk = normalizeRisk(input.risk, team.pipeline?.unknown_risk_is_high !== false);
  const contributions = contributionScores(input.codegraph, paths);

  const candidates = team.people
    .filter((person) => person.active !== false && !/\[bot\]$/i.test(person.github))
    .map((person, index) => {
      const login = lower(person.github);
      const matchedPaths = paths.filter((filePath) => asArray(person.responsibilities?.paths).some((pattern) => matchesGlob(filePath, pattern)));
      const matchedDomains = domainMatchesPerson(person, domains) ? domains.filter((domain) => asArray(person.responsibilities?.domains).map(lower).includes(domain)) : [];
      const blameRaw = contributions.blame.get(login) ?? 0;
      const recentRaw = contributions.recent.get(login) ?? 0;
      const breakdown = {
        issue_assignee: login === issueAssignee ? 100 : 0,
        path_owner: matchedPaths.length ? 80 : 0,
        domain_owner: matchedDomains.length ? 60 : 0,
        blame: contributions.maxBlame ? Math.round((blameRaw / contributions.maxBlame) * 40) : 0,
        recent_commits: contributions.maxRecent ? Math.round((recentRaw / contributions.maxRecent) * 20) : 0,
      };
      return {
        github: person.github,
        score: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
        breakdown,
        matched_paths: matchedPaths,
        matched_domains: matchedDomains,
        can_review: person.review?.can_review === true,
        high_risk_qualified:
          risk !== "high" ||
          domains.some((domain) => asArray(person.review?.high_risk_domains).map(lower).includes(domain)) ||
          paths.some((filePath) => asArray(person.review?.high_risk_paths).some((pattern) => matchesGlob(filePath, pattern))),
        excluded_from_review: login === author || login === implementer,
        _index: index,
      };
    })
    .sort((left, right) => right.score - left.score || left._index - right._index || left.github.localeCompare(right.github));

  const maxAssignees = asInteger(team.pipeline?.max_pr_assignees, 3);
  const assignees = candidates.filter((candidate) => candidate.score >= 60).slice(0, maxAssignees).map((candidate) => candidate.github);
  const reviewerCandidate = candidates.find(
    (candidate) => assignees.includes(candidate.github) && candidate.can_review && !candidate.excluded_from_review && candidate.high_risk_qualified,
  );
  const fallback = team.pipeline?.fallback_assignee;
  return {
    assignees,
    reviewer: reviewerCandidate?.github ?? null,
    human_required: !reviewerCandidate,
    fallback_mention: reviewerCandidate ? null : fallback ? `@${fallback}` : null,
    risk,
    candidates: candidates.map(({ _index, ...candidate }) => candidate),
  };
}

export function checkProtectedPaths(team, paths, approved = false) {
  const normalizedPaths = readPaths(paths);
  const patterns = asArray(team.pipeline?.protected_paths);
  const matches = matchingPatterns(normalizedPaths, patterns).map((entry) => {
    const split = entry.lastIndexOf(":");
    return { path: entry.slice(0, split), pattern: entry.slice(split + 1) };
  });
  return {
    passed: matches.length === 0 || asBoolean(approved),
    approved: asBoolean(approved),
    matched: unique(matches.map((match) => match.path)),
    matches,
    requires_human: matches.length > 0 && !asBoolean(approved),
  };
}

function flattenComments(value) {
  if (Array.isArray(value)) return value.flatMap(flattenComments);
  if (isObject(value) && Array.isArray(value.comments)) return flattenComments(value.comments);
  return isObject(value) ? [value] : [];
}

function protectedReviewerEligibility(team, loginInput, paths, implementerInput) {
  const login = lower(loginInput);
  const implementer = lower(implementerInput);
  const person = team.people.find((candidate) => lower(candidate.github) === login);
  if (!person || person.active === false) return { eligible: false, reason: "reviewer_not_active_team_member", uncovered: paths };
  if (person.review?.can_review !== true) return { eligible: false, reason: "reviewer_not_authorized", uncovered: paths };
  if (/\[bot\]$/i.test(String(person.github ?? ""))) return { eligible: false, reason: "reviewer_is_bot", uncovered: paths };
  if (!implementer) return { eligible: false, reason: "implementer_unknown", uncovered: paths };
  if (login === implementer) return { eligible: false, reason: "reviewer_is_implementer", uncovered: paths };
  const patterns = asArray(person.review?.high_risk_paths);
  const uncovered = paths.filter((filePath) => !patterns.some((pattern) => matchesGlob(filePath, pattern)));
  return { eligible: uncovered.length === 0, reason: uncovered.length ? "reviewer_lacks_path_coverage" : "eligible", uncovered };
}

function failedProtectedAuthorization(check, request, fields = {}) {
  return {
    ...check,
    passed: false,
    approved: false,
    requires_human: true,
    authorization_required: true,
    request_present: request.present,
    request_valid: request.valid,
    requested: request.paths,
    approval_comment_id: null,
    approved_by: null,
    ...fields,
  };
}

/**
 * Authorizes a protected-path exception from fresh source-Issue evidence only.
 * Model output is deliberately not accepted by this interface.
 */
export function authorizeProtectedPaths(team, input = {}) {
  const issue = input.issue?.issue ?? input.issue ?? {};
  const request = parseProtectedRequest(issue);
  const explicitPaths = input.paths !== undefined || input.changed_paths !== undefined || input.changed_files !== undefined;
  const paths = explicitPaths
    ? readPaths(input.paths ?? input.changed_paths ?? input.changed_files)
    : request.valid
      ? request.paths
      : [];
  const check = checkProtectedPaths(team, paths, false);
  const authorizationRequired = explicitPaths ? check.matched.length > 0 : request.present;
  const issueNumber = asInteger(issue?.number, 0);
  if (!explicitPaths && !asBoolean(input.evidence_fresh, false)) {
    return failedProtectedAuthorization(check, request, {
      issue: issueNumber || null,
      reason: "fresh_api_evidence_required",
      eligible_reviewers: [],
      rejected_approvals: [],
    });
  }
  if (!authorizationRequired) {
    return {
      ...check,
      passed: true,
      approved: false,
      requires_human: false,
      authorization_required: false,
      request_present: request.present,
      request_valid: request.valid,
      requested: request.paths,
      reason: "no_protected_paths",
      implementer: input.implementer ?? input.state?.assignee ?? null,
      eligible_reviewers: [],
      rejected_approvals: [],
      approval_comment_id: null,
      approved_by: null,
    };
  }

  const manualOnlyWorkflows = check.matched.filter((filePath) => matchesGlob(filePath, ".github/workflows/**"));
  if (manualOnlyWorkflows.length) {
    return failedProtectedAuthorization(check, request, {
      issue: issueNumber || null,
      reason: "workflow_definition_requires_manual_change",
      manual_only: manualOnlyWorkflows,
      eligible_reviewers: [],
      rejected_approvals: [],
    });
  }
  if (!asBoolean(input.evidence_fresh, false)) {
    return failedProtectedAuthorization(check, request, { issue: issueNumber || null, reason: "fresh_api_evidence_required", eligible_reviewers: [], rejected_approvals: [] });
  }
  if (!issueNumber) {
    return failedProtectedAuthorization(check, request, { issue: null, reason: "source_issue_number_missing", eligible_reviewers: [], rejected_approvals: [] });
  }
  if (!request.present) {
    return failedProtectedAuthorization(check, request, { issue: issueNumber, reason: "protected_request_marker_missing", eligible_reviewers: [], rejected_approvals: [] });
  }
  if (!request.valid) {
    return failedProtectedAuthorization(check, request, { issue: issueNumber, reason: request.reason, eligible_reviewers: [], rejected_approvals: [] });
  }

  const protectedPatterns = asArray(team.pipeline?.protected_paths);
  const unprotectedRequests = request.paths.filter((filePath) => !protectedPatterns.some((pattern) => matchesGlob(filePath, pattern)));
  if (unprotectedRequests.length) {
    return failedProtectedAuthorization(check, request, {
      issue: issueNumber,
      reason: "request_contains_non_protected_paths",
      unprotected_requests: unprotectedRequests,
      eligible_reviewers: [],
      rejected_approvals: [],
    });
  }
  const unrequestedChanges = check.matched.filter((filePath) => !request.paths.includes(filePath));
  if (unrequestedChanges.length) {
    return failedProtectedAuthorization(check, request, {
      issue: issueNumber,
      reason: "protected_change_not_exactly_requested",
      unrequested_changes: unrequestedChanges,
      eligible_reviewers: [],
      rejected_approvals: [],
    });
  }

  let implementer = String(input.implementer ?? input.state?.assignee ?? "").trim();
  if (!implementer) {
    try {
      implementer = String(selectOwner(team, issue).assignee ?? "").trim();
    } catch {
      implementer = "";
    }
  }
  const eligibleReviewers = team.people
    .filter((person) => protectedReviewerEligibility(team, person.github, request.paths, implementer).eligible)
    .map((person) => person.github);
  if (!implementer) {
    return failedProtectedAuthorization(check, request, {
      issue: issueNumber,
      reason: "implementer_unknown",
      implementer: null,
      eligible_reviewers: eligibleReviewers,
      rejected_approvals: [],
    });
  }

  const comments = flattenComments(input.comments).sort(
    (left, right) =>
      String(right.updated_at ?? right.created_at ?? "").localeCompare(String(left.updated_at ?? left.created_at ?? "")) ||
      asInteger(right.id, 0) - asInteger(left.id, 0),
  );
  const rejected = [];
  for (const comment of comments) {
    const command = parseProtectedApprovalCommand(comment.body);
    if (!command.present) continue;
    let reason = null;
    const login = String(comment.user?.login ?? "");
    if (!command.valid) reason = command.reason;
    else if (command.issue !== issueNumber) reason = "approval_issue_mismatch";
    else if (!samePathSet(command.paths, request.paths)) reason = "approval_scope_mismatch";
    else if (!WRITE_ASSOCIATIONS.has(String(comment.author_association ?? "NONE").toUpperCase())) reason = "approval_requires_write_access";
    else if (lower(comment.user?.type) !== "user" || /\[bot\]$/i.test(login)) reason = "approval_requires_human_user";
    else {
      const eligibility = protectedReviewerEligibility(team, login, request.paths, implementer);
      if (!eligibility.eligible) reason = eligibility.reason;
    }
    if (reason) {
      rejected.push({ comment_id: asInteger(comment.id, 0) || null, login: login || null, reason });
      continue;
    }
    return {
      ...checkProtectedPaths(team, paths, true),
      authorization_required: true,
      request_present: true,
      request_valid: true,
      requested: request.paths,
      issue: issueNumber,
      reason: "approved_by_eligible_human_reviewer",
      implementer,
      eligible_reviewers: eligibleReviewers,
      rejected_approvals: rejected,
      approval_comment_id: asInteger(comment.id, 0) || null,
      approved_by: login,
      approved_at: comment.updated_at ?? comment.created_at ?? null,
    };
  }
  return failedProtectedAuthorization(check, request, {
    issue: issueNumber,
    reason: eligibleReviewers.length ? "eligible_approval_not_found" : "no_eligible_protected_reviewer",
    implementer,
    eligible_reviewers: eligibleReviewers,
    rejected_approvals: rejected,
  });
}

function normalizeRiskAssessment(value = {}) {
  const choose = (candidate, allowed) => (allowed.includes(lower(candidate)) ? lower(candidate) : "unknown");
  return {
    impact: choose(value.impact, RISK_IMPACTS),
    likelihood: choose(value.likelihood, RISK_LIKELIHOODS),
    blast_radius: choose(value.blast_radius, RISK_BLAST_RADII),
    reversibility: choose(value.reversibility, RISK_REVERSIBILITY),
    detectability: choose(value.detectability, RISK_DETECTABILITY),
    evidence: String(value.evidence ?? ""),
  };
}

function materialityIsHigh(assessmentInput, hasRiskContext = true) {
  const assessment = normalizeRiskAssessment(assessmentInput);
  if (["material", "severe"].includes(assessment.impact)) return true;
  if (assessment.blast_radius === "broad") return true;
  if (["difficult", "irreversible"].includes(assessment.reversibility)) return true;
  if (assessment.detectability === "weak" && ["possible", "likely", "unknown"].includes(assessment.likelihood)) return true;
  return (
    hasRiskContext &&
    [assessment.impact, assessment.likelihood, assessment.blast_radius, assessment.reversibility, assessment.detectability].includes("unknown")
  );
}

export function evaluateRisk(team, input = {}) {
  const paths = readPaths(input.changed_paths ?? input.changed_files ?? input.paths);
  const domains = asArray(input.domains).map(lower);
  const text = [
    input.title,
    input.body,
    input.problem,
    input.impact,
    input.intake?.problem,
    input.intake?.expected_result,
    input.intake?.actual_result,
    input.intake?.impact,
    ...asArray(input.intake?.relevant_logs),
  ].filter((value) => value !== undefined && value !== null).join("\n").toLowerCase();
  const protectedResult = checkProtectedPaths(team, paths, input.protected_approved);
  const reasons = [];
  if (protectedResult.matched.length) reasons.push({ type: "protected_path", values: protectedResult.matched });
  const highRiskPaths = unique(
    team.people.filter((person) => person.active !== false).flatMap((person) =>
      paths.filter((filePath) => asArray(person.review?.high_risk_paths).some((pattern) => matchesGlob(filePath, pattern))),
    ),
  );
  if (highRiskPaths.length) reasons.push({ type: "high_risk_path", values: highRiskPaths });
  const highRiskDomains = unique(
    team.people
      .filter((person) => person.active !== false)
      .flatMap((person) => domains.filter((domain) => asArray(person.review?.high_risk_domains).map(lower).includes(domain))),
  );
  if (highRiskDomains.length) reasons.push({ type: "high_risk_domain", values: highRiskDomains });
  const configuredCategories = asArray(team.pipeline?.risk_policy?.categories);
  const detectedCategories = configuredCategories
    .map((category) => ({
      id: String(category?.id ?? ""),
      signals: asArray(category?.signals).map(String).filter((signal) => hasTerm(text, signal)),
      high_impact_signals: asArray(category?.high_impact_signals).map(String).filter((signal) => hasTerm(text, signal)),
    }))
    .filter((category) => category.id && (category.signals.length || category.high_impact_signals.length));
  for (const category of detectedCategories) {
    if (category.high_impact_signals.length) {
      reasons.push({ type: "high_impact_signal", category: category.id, values: category.high_impact_signals });
    }
  }
  const reportedCategories = unique(asArray(input.risk_categories).map(lower).filter((category) => RISK_CATEGORY_IDS.includes(category)));
  const riskAssessment = normalizeRiskAssessment(input.risk_assessment);
  if (materialityIsHigh(riskAssessment, reportedCategories.length > 0 || detectedCategories.length > 0)) {
    reasons.push({ type: "reported_materiality", values: [riskAssessment.impact, riskAssessment.likelihood, riskAssessment.blast_radius, riskAssessment.reversibility, riskAssessment.detectability] });
  }
  const intakeRisk = lower(input.intake?.security_or_privacy);
  if (["present", "unknown"].includes(intakeRisk)) reasons.push({ type: "security_or_privacy", values: [intakeRisk] });
  const agentRisk = normalizeRisk(input.risk ?? input.agent_risk, team.pipeline?.unknown_risk_is_high !== false);
  if (agentRisk === "high") reasons.push({ type: "agent_risk", values: [String(input.risk ?? input.agent_risk ?? "unknown")] });
  return {
    risk: reasons.length ? "high" : "low",
    deterministic_high: reasons.some((reason) => !["agent_risk", "reported_materiality"].includes(reason.type)),
    agent_risk: agentRisk,
    reasons,
    categories: unique([...detectedCategories.map((category) => category.id), ...reportedCategories]),
    candidate_categories: detectedCategories.map((category) => ({ category: category.id, signals: category.signals })),
    risk_assessment: riskAssessment,
    protected_paths: protectedResult,
  };
}

function parseEmbeddedJson(value) {
  if (isObject(value) || Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    // Only a complete JSON value is accepted. unwrapAgentOutput may recursively
    // parse complete JSON strings in known provider envelope fields, but prose,
    // markdown fences, and prefix/suffix extraction are never accepted.
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function unwrapAgentOutput(raw, kind) {
  const direct = parseEmbeddedJson(raw);
  invariant(direct !== null, "Agent output does not contain JSON", "INVALID_AGENT_OUTPUT");
  const looksLikeKind = (value) => {
    if (!isObject(value)) return false;
    if (kind === "review") return "verdict" in value || "findings" in value;
    if (kind === "plan") return "problems" in value || "steps" in value;
    if (kind === "triage") return "assignee" in value || "intake" in value || "risk" in value;
    return true;
  };
  const queue = [direct];
  const visited = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (looksLikeKind(value)) return value;
    if (typeof value === "string") {
      const parsed = parseEmbeddedJson(value);
      if (parsed !== null) queue.push(parsed);
      continue;
    }
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (!isObject(value) || visited.has(value)) continue;
    visited.add(value);
    for (const key of ["structured_output", "output", "result", "final_output", "content", "message", "text", "data"]) {
      if (value[key] !== undefined) queue.push(value[key]);
    }
  }
  throw new PipelineError(`Agent output does not contain a ${kind} object`, "INVALID_AGENT_OUTPUT");
}

function validateAgentStage(value, kind) {
  const errors = [];
  const object = (candidate, path) => {
    if (!isObject(candidate)) errors.push(`${path} must be an object`);
    return isObject(candidate);
  };
  const exact = (candidate, required, path) => {
    if (!object(candidate, path)) return;
    for (const key of required) if (!(key in candidate)) errors.push(`${path}.${key} is required`);
    for (const key of Object.keys(candidate)) if (!required.includes(key)) errors.push(`${path}.${key} is not allowed`);
  };
  const string = (candidate, path, nullable = false) => {
    if (nullable && candidate === null) return;
    if (typeof candidate !== "string" || candidate.length === 0) errors.push(`${path} must be a non-empty string${nullable ? " or null" : ""}`);
  };
  const strings = (candidate, path) => {
    if (!Array.isArray(candidate)) errors.push(`${path} must be an array`);
    else {
      candidate.forEach((item, index) => string(item, `${path}[${index}]`));
      if (new Set(candidate).size !== candidate.length) errors.push(`${path} must contain unique values`);
    }
  };
  const enumValue = (candidate, allowed, path) => {
    if (!allowed.includes(candidate)) errors.push(`${path} must be one of: ${allowed.join(", ")}`);
  };
  const problem = (candidate, path) => {
    const keys = ["id", "problem", "risk", "status", "evidence", "owner", "next_step"];
    exact(candidate, keys, path);
    if (!isObject(candidate)) return;
    string(candidate.id, `${path}.id`);
    if (typeof candidate.id === "string" && !/^P-\d{3,}$/.test(candidate.id)) errors.push(`${path}.id must match P-NNN`);
    string(candidate.problem, `${path}.problem`);
    enumValue(candidate.risk, ["low", "high"], `${path}.risk`);
    enumValue(candidate.status, [...PROBLEM_STATUSES], `${path}.status`);
    string(candidate.evidence, `${path}.evidence`);
    string(candidate.owner, `${path}.owner`, true);
    string(candidate.next_step, `${path}.next_step`);
  };
  const unit = (candidate, path) => {
    const keys = ["id", "title", "problem_ids", "steps", "changed_paths"];
    exact(candidate, keys, path);
    if (!isObject(candidate)) return;
    string(candidate.id, `${path}.id`);
    if (typeof candidate.id === "string" && !/^U[0-9]+$/.test(candidate.id)) errors.push(`${path}.id must match U<N>`);
    string(candidate.title, `${path}.title`);
    strings(candidate.problem_ids, `${path}.problem_ids`);
    if (Array.isArray(candidate.problem_ids)) {
      if (candidate.problem_ids.length === 0) errors.push(`${path}.problem_ids must not be empty`);
      candidate.problem_ids.forEach((id, index) => {
        if (typeof id === "string" && !/^P-\d{3,}$/.test(id)) errors.push(`${path}.problem_ids[${index}] must match P-NNN`);
      });
    }
    strings(candidate.steps, `${path}.steps`);
    if (Array.isArray(candidate.steps) && candidate.steps.length === 0) errors.push(`${path}.steps must not be empty`);
    strings(candidate.changed_paths, `${path}.changed_paths`);
    if (Array.isArray(candidate.changed_paths) && candidate.changed_paths.length === 0) errors.push(`${path}.changed_paths must not be empty`);
  };

  if (kind === "triage") {
    const keys = ["intake", "assignee", "agent", "risk", "risk_categories", "risk_assessment", "domains", "changed_paths", "rationale"];
    exact(value, keys, "$" );
    if (isObject(value)) {
      exact(value.intake, ["problem", "reproduction_steps", "expected_result", "actual_result", "impact", "relevant_logs", "security_or_privacy"], "$.intake");
      if (isObject(value.intake)) {
        string(value.intake.problem, "$.intake.problem", true);
        strings(value.intake.reproduction_steps, "$.intake.reproduction_steps");
        string(value.intake.expected_result, "$.intake.expected_result", true);
        string(value.intake.actual_result, "$.intake.actual_result", true);
        string(value.intake.impact, "$.intake.impact", true);
        strings(value.intake.relevant_logs, "$.intake.relevant_logs");
        enumValue(value.intake.security_or_privacy, ["none", "present", "unknown"], "$.intake.security_or_privacy");
      }
      string(value.assignee, "$.assignee");
      enumValue(value.agent, ["codex", "claude"], "$.agent");
      enumValue(value.risk, ["low", "high"], "$.risk");
      strings(value.risk_categories, "$.risk_categories");
      if (Array.isArray(value.risk_categories)) {
        value.risk_categories.forEach((category, index) => enumValue(category, RISK_CATEGORY_IDS, `$.risk_categories[${index}]`));
      }
      exact(value.risk_assessment, ["impact", "likelihood", "blast_radius", "reversibility", "detectability", "evidence"], "$.risk_assessment");
      if (isObject(value.risk_assessment)) {
        enumValue(value.risk_assessment.impact, RISK_IMPACTS, "$.risk_assessment.impact");
        enumValue(value.risk_assessment.likelihood, RISK_LIKELIHOODS, "$.risk_assessment.likelihood");
        enumValue(value.risk_assessment.blast_radius, RISK_BLAST_RADII, "$.risk_assessment.blast_radius");
        enumValue(value.risk_assessment.reversibility, RISK_REVERSIBILITY, "$.risk_assessment.reversibility");
        enumValue(value.risk_assessment.detectability, RISK_DETECTABILITY, "$.risk_assessment.detectability");
        string(value.risk_assessment.evidence, "$.risk_assessment.evidence");
        if (value.risk === "low" && materialityIsHigh(value.risk_assessment, asArray(value.risk_categories).length > 0)) {
          errors.push("$.risk must be high when the materiality assessment is high or materially uncertain");
        }
        if (asArray(value.risk_categories).includes("equivalent_severity") && value.risk !== "high") {
          errors.push("$.risk must be high for equivalent_severity");
        }
      }
      strings(value.domains, "$.domains");
      strings(value.changed_paths, "$.changed_paths");
      string(value.rationale, "$.rationale");
    }
  } else if (kind === "plan") {
    const keys = ["issue", "iteration", "phase", "risk", "problems", "steps", "validation_commands", "changed_paths", "units"];
    exact(value, keys, "$");
    if (isObject(value)) {
      if (!Number.isInteger(value.issue) || value.issue < 1) errors.push("$.issue must be a positive integer");
      if (!Number.isInteger(value.iteration) || value.iteration < 1) errors.push("$.iteration must be a positive integer");
      enumValue(value.phase, ["plan"], "$.phase");
      enumValue(value.risk, ["low", "high"], "$.risk");
      if (!Array.isArray(value.problems)) errors.push("$.problems must be an array");
      else value.problems.forEach((item, index) => problem(item, `$.problems[${index}]`));
      strings(value.steps, "$.steps");
      if (Array.isArray(value.steps) && value.steps.length === 0) errors.push("$.steps must not be empty");
      strings(value.validation_commands, "$.validation_commands");
      if (Array.isArray(value.validation_commands) && value.validation_commands.length === 0) errors.push("$.validation_commands must not be empty");
      strings(value.changed_paths, "$.changed_paths");
      if (!Array.isArray(value.units)) errors.push("$.units must be an array");
      else {
        value.units.forEach((item, index) => unit(item, `$.units[${index}]`));
        if (value.units.length === 1) errors.push("$.units must contain either zero entries (no split) or two or more");
      }
    }
  } else if (kind === "review") {
    exact(value, ["verdict", "reviewed_sha", "findings"], "$");
    if (isObject(value)) {
      enumValue(value.verdict, ["pass", "fix_required"], "$.verdict");
      string(value.reviewed_sha, "$.reviewed_sha");
      if (typeof value.reviewed_sha === "string" && !/^[0-9a-fA-F]{40}$/.test(value.reviewed_sha)) errors.push("$.reviewed_sha must be a 40-character SHA");
      if (!Array.isArray(value.findings)) errors.push("$.findings must be an array");
      else {
        value.findings.forEach((finding, index) => {
          const path = `$.findings[${index}]`;
          const keys = ["id", "path", "line", "problem", "risk", "must_fix", "suggested_fix", "human_owner"];
          exact(finding, keys, path);
          if (!isObject(finding)) return;
          string(finding.id, `${path}.id`);
          if (typeof finding.id === "string" && !/^P-\d{3,}$/.test(finding.id)) errors.push(`${path}.id must match P-NNN`);
          string(finding.path, `${path}.path`);
          if (!Number.isInteger(finding.line) || finding.line < 1) errors.push(`${path}.line must be a positive integer`);
          string(finding.problem, `${path}.problem`);
          enumValue(finding.risk, ["low", "high", "unknown"], `${path}.risk`);
          if (typeof finding.must_fix !== "boolean") errors.push(`${path}.must_fix must be a boolean`);
          string(finding.suggested_fix, `${path}.suggested_fix`);
          string(finding.human_owner, `${path}.human_owner`, true);
          if (["high", "unknown"].includes(finding.risk) && finding.must_fix !== true) {
            errors.push(`${path}.must_fix must be true for high or unknown risk`);
          }
        });
        const actionable = value.findings.some((finding) => isObject(finding) && finding.must_fix === true);
        if (value.verdict === "fix_required" && !actionable) errors.push("$.findings must contain a must-fix finding when verdict is fix_required");
        if (value.verdict === "pass" && actionable) errors.push("$.findings must not contain a must-fix finding when verdict is pass");
      }
    }
  } else errors.push(`unsupported kind: ${kind}`);
  if (errors.length) throw new PipelineError(`Agent ${kind} output failed schema validation`, "INVALID_AGENT_OUTPUT", { errors });
}

function normalizePlanUnit(unit, index) {
  return {
    id: String(unit?.id ?? `U${index + 1}`),
    title: String(unit?.title ?? unit?.id ?? `Unit ${index + 1}`),
    problem_ids: unique(asArray(unit?.problem_ids).map(String)),
    steps: asArray(unit?.steps).map(String).filter(Boolean),
    changed_paths: unique(asArray(unit?.changed_paths).map(normalizeRepoPath)),
  };
}

function normalizeProblem(problem, index) {
  const risk = normalizeRisk(problem?.risk, true);
  return {
    id: String(problem?.id ?? `P-${String(index + 1).padStart(3, "0")}`),
    problem: String(problem?.problem ?? problem?.summary ?? "Unspecified problem"),
    risk,
    status: canonicalStatus(problem?.status, "OPEN"),
    evidence: String(problem?.evidence ?? problem?.basis ?? problem?.location ?? ""),
    owner: problem?.owner ?? problem?.human_owner ?? null,
    next_step: String(problem?.next_step ?? ""),
  };
}

function normalizeIntake(intake = {}) {
  const security = lower(intake.security_or_privacy);
  return {
    problem: intake.problem === null || intake.problem === undefined ? null : String(intake.problem),
    reproduction_steps: asArray(intake.reproduction_steps).map(String),
    expected_result: intake.expected_result === null || intake.expected_result === undefined ? null : String(intake.expected_result),
    actual_result: intake.actual_result === null || intake.actual_result === undefined ? null : String(intake.actual_result),
    impact: intake.impact === null || intake.impact === undefined ? null : String(intake.impact),
    relevant_logs: asArray(intake.relevant_logs).map(String),
    security_or_privacy: ["none", "present", "unknown"].includes(security) ? security : "unknown",
  };
}

export function normalizeAgentOutput(raw, kind, options = {}) {
  const value = unwrapAgentOutput(raw, kind);
  validateAgentStage(value, kind);
  if (kind === "triage") {
    const intake = normalizeIntake(value.intake);
    const riskCategories = unique(asArray(value.risk_categories).map(lower));
    const riskAssessment = normalizeRiskAssessment(value.risk_assessment);
    return {
      assignee: value.assignee ?? null,
      agent: value.agent ?? options.agent ?? null,
      risk:
        materialityIsHigh(riskAssessment, riskCategories.length > 0) ||
        intake.security_or_privacy === "unknown" ||
        intake.security_or_privacy === "present"
          ? "high"
          : normalizeRisk(value.risk, true),
      risk_categories: riskCategories,
      risk_assessment: riskAssessment,
      domains: unique(asArray(value.domains).map(lower)),
      changed_paths: unique(asArray(value.changed_paths).map(normalizeRepoPath)),
      intake,
      rationale: String(value.rationale ?? ""),
    };
  }
  if (kind === "plan") {
    return {
      issue: value.issue === null || value.issue === undefined ? null : asInteger(value.issue, null),
      iteration: Math.max(0, asInteger(value.iteration, 0)),
      phase: String(value.phase ?? "plan"),
      risk: normalizeRisk(value.risk, true),
      problems: asArray(value.problems).map(normalizeProblem),
      steps: asArray(value.steps).map((step) => (typeof step === "string" ? step : String(step?.description ?? step?.step ?? ""))).filter(Boolean),
      validation_commands: asArray(value.validation_commands).map(String),
      changed_paths: unique(asArray(value.changed_paths).map(normalizeRepoPath)),
      units: asArray(value.units).map(normalizePlanUnit),
    };
  }
  if (kind === "review") {
    const verdict = value.verdict;
    const findings = asArray(value.findings).map((finding, index) => {
      const risk = normalizeRisk(finding?.risk, true);
      return {
        id: String(finding?.id ?? `P-${String(index + 1).padStart(3, "0")}`),
        path: normalizeRepoPath(finding?.path),
        line: Math.max(1, asInteger(finding?.line, 1)),
        problem: String(finding?.problem ?? "Unspecified review finding"),
        risk,
        must_fix: finding?.must_fix === undefined ? risk === "high" : asBoolean(finding.must_fix),
        suggested_fix: String(finding?.suggested_fix ?? ""),
        human_owner: finding?.human_owner ?? null,
      };
    });
    return {
      verdict,
      reviewed_sha: String(value.reviewed_sha ?? ""),
      findings,
    };
  }
  throw new PipelineError(`Unsupported normalization kind: ${kind}`, "INVALID_ARGUMENT");
}

function normalizeUnitId(value) {
  return value === undefined || value === null || value === "" ? null : String(value);
}

function normalizeUnitsIndex(value) {
  return asArray(value)
    .filter(isObject)
    .map((entry) => ({
      id: String(entry.id ?? ""),
      title: String(entry.title ?? ""),
      branch: entry.branch === undefined || entry.branch === null || entry.branch === "" ? null : String(entry.branch),
      pr: entry.pr === undefined || entry.pr === null ? null : asInteger(entry.pr, null),
    }))
    .filter((entry) => entry.id);
}

export function initialState(input = {}) {
  return {
    version: PIPELINE_VERSION,
    issue: input.issue === undefined || input.issue === null ? null : asInteger(input.issue, null),
    // null identifies the single pre-split/overview thread. A non-null unit
    // marks one independently reviewable semantic-unit PR spawned from this
    // Issue; each unit gets its own canonical state comment and lifecycle.
    unit: normalizeUnitId(input.unit),
    units_index: normalizeUnitsIndex(input.units_index),
    phase: String(input.phase ?? "intake"),
    iteration: Math.max(0, asInteger(input.iteration, 0)),
    branch: input.branch === undefined || input.branch === null || input.branch === "" ? null : String(input.branch),
    pr: input.pr === undefined || input.pr === null ? null : asInteger(input.pr, null),
    assignee: input.assignee === undefined || input.assignee === null || input.assignee === "" ? null : String(input.assignee),
    reviewer: input.reviewer === undefined || input.reviewer === null || input.reviewer === "" ? null : String(input.reviewer),
    agent: input.agent === undefined || input.agent === null || input.agent === "" ? null : String(input.agent),
    plan: input.plan === undefined || input.plan === null ? null : deepClone(input.plan),
    reviewed_sha: input.reviewed_sha === undefined || input.reviewed_sha === null || input.reviewed_sha === "" ? null : String(input.reviewed_sha),
    current_sha:
      input.current_sha === undefined || input.current_sha === null || input.current_sha === ""
        ? input.head_sha === undefined || input.head_sha === null || input.head_sha === ""
          ? null
          : String(input.head_sha)
        : String(input.current_sha),
    all_ok: asBoolean(input.all_ok, false),
    problems: asArray(input.problems).map(normalizeProblem),
    validation: normalizeValidation(input.validation),
    protected_paths: normalizeProtectedState(input.protected_paths),
    change_scope: normalizeChangeScope(input.change_scope),
  };
}

function normalizeChangeScope(value) {
  if (!isObject(value)) {
    return {
      passed: false,
      commit_unit: "single_crud_bundle",
      pr_unit: "single_semantic_unit",
      additions: 0,
      deletions: 0,
      changed_lines: 0,
      target: 0,
      maximum: 0,
      binary: false,
      split_required: false,
      recommended_pr_count: 0,
      reason: "not_evaluated",
    };
  }
  return {
    passed: value.passed === true,
    commit_unit: String(value.commit_unit ?? "single_crud_bundle"),
    pr_unit: String(value.pr_unit ?? "single_semantic_unit"),
    additions: Math.max(0, asInteger(value.additions, 0)),
    deletions: Math.max(0, asInteger(value.deletions, 0)),
    changed_lines: Math.max(0, asInteger(value.changed_lines, 0)),
    target: Math.max(0, asInteger(value.target, 0)),
    maximum: Math.max(0, asInteger(value.maximum, 0)),
    binary: value.binary === true,
    split_required: value.split_required === true,
    recommended_pr_count: Math.max(0, asInteger(value.recommended_pr_count, 0)),
    reason: String(value.reason ?? "not_evaluated"),
  };
}

function normalizeValidation(validation) {
  if (validation === true) return { passed: true, commands: [] };
  if (!isObject(validation)) return { passed: false, commands: [] };
  const commands = asArray(validation.commands).map((command) => {
    if (typeof command === "string") return { command, passed: false, exit_code: null };
    return {
      command: String(command?.command ?? ""),
      passed: command?.passed === true,
      exit_code: command?.exit_code === undefined || command?.exit_code === null ? null : asInteger(command.exit_code, null),
    };
  });
  return { passed: validation.passed === true, commands };
}

function normalizeProtectedState(value) {
  const empty = {
    passed: false,
    matched: [],
    scope_approved_by: null,
    scope_approval_comment_id: null,
    content_approved_by: null,
    content_approved_sha: null,
  };
  if (value === true) return { ...empty, passed: true };
  if (!isObject(value)) return empty;
  return {
    passed: value.passed === true,
    matched: unique(asArray(value.matched).map(normalizeRepoPath)),
    scope_approved_by:
      value.scope_approved_by === undefined || value.scope_approved_by === null || value.scope_approved_by === ""
        ? value.approved_by === undefined || value.approved_by === null || value.approved_by === ""
          ? null
          : String(value.approved_by)
        : String(value.scope_approved_by),
    scope_approval_comment_id:
      value.scope_approval_comment_id === undefined || value.scope_approval_comment_id === null
        ? value.approval_comment_id === undefined || value.approval_comment_id === null
          ? null
          : asInteger(value.approval_comment_id, null)
        : asInteger(value.scope_approval_comment_id, null),
    content_approved_by:
      value.content_approved_by === undefined || value.content_approved_by === null || value.content_approved_by === ""
        ? null
        : String(value.content_approved_by),
    content_approved_sha:
      value.content_approved_sha === undefined || value.content_approved_sha === null || value.content_approved_sha === ""
        ? null
        : String(value.content_approved_sha),
  };
}

export function mergeState(current, update = {}) {
  const base = initialState(current);
  const merged = {
    ...base,
    ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)),
  };
  if (update.problems === undefined) merged.problems = base.problems;
  if (update.validation === undefined) merged.validation = base.validation;
  if (update.protected_paths === undefined) merged.protected_paths = base.protected_paths;
  else if (isObject(update.protected_paths)) {
    const protectedUpdate = normalizeProtectedState(update.protected_paths);
    merged.protected_paths = {
      ...protectedUpdate,
      content_approved_by:
        Object.prototype.hasOwnProperty.call(update.protected_paths, "content_approved_by")
          ? protectedUpdate.content_approved_by
          : base.protected_paths.content_approved_by,
      content_approved_sha:
        Object.prototype.hasOwnProperty.call(update.protected_paths, "content_approved_sha")
          ? protectedUpdate.content_approved_sha
          : base.protected_paths.content_approved_sha,
    };
  }
  if (update.change_scope === undefined) merged.change_scope = base.change_scope;
  return initialState(merged);
}

export function evaluateAllOk(reviewInput, stateInput, options = {}) {
  const review = normalizeAgentOutput(reviewInput, "review");
  const state = initialState(stateInput);
  const currentSha = String(options.current_sha ?? state.current_sha ?? "");
  const openStatuses = new Set(["OPEN", "PLANNED", "IN_PROGRESS", "HUMAN_REQUIRED"]);
  const persistedMustFix = state.problems.filter((problem) => openStatuses.has(problem.status));
  const persistedHigh = state.problems.filter((problem) => problem.risk === "high" && !["FIXED", "DONE"].includes(problem.status));
  const reviewMustFix = review.findings.filter((finding) => finding.must_fix && !finding.resolved);
  const reviewHigh = review.findings.filter((finding) => finding.risk === "high" && !finding.resolved);
  const unresolvedMustFixIds = unique([...persistedMustFix.map((problem) => problem.id), ...reviewMustFix.map((finding) => finding.id)]);
  const unresolvedHighIds = unique([...persistedHigh.map((problem) => problem.id), ...reviewHigh.map((finding) => finding.id)]);
  const validationCommandsPassed =
    state.validation.commands.length === 0 || state.validation.commands.every((command) => command.passed === true && command.exit_code !== null && command.exit_code === 0);
  const protectedContentApproved =
    state.protected_paths.matched.length === 0 ||
    (Boolean(state.protected_paths.content_approved_by) && state.protected_paths.content_approved_sha === currentSha);
  const checks = {
    review_passed: review.verdict === "pass",
    no_open_must_fix_findings: unresolvedMustFixIds.length === 0,
    validation_passed: state.validation.passed === true && validationCommandsPassed,
    no_unresolved_high_risk_findings: unresolvedHighIds.length === 0,
    reviewed_current_head: Boolean(review.reviewed_sha) && Boolean(currentSha) && review.reviewed_sha === currentSha,
    protected_path_policy_passed: state.protected_paths.passed === true,
    protected_content_approved_for_head: protectedContentApproved,
    change_scope_passed: state.change_scope.passed === true,
  };
  const allOk = Object.values(checks).every(Boolean);
  const maxIterations = options.max_auto_iterations === undefined ? null : asInteger(options.max_auto_iterations, null);
  const exhausted = maxIterations !== null && state.iteration >= maxIterations && !allOk;
  const humanRequired =
    unresolvedHighIds.length > 0 ||
    exhausted ||
    state.protected_paths.passed !== true ||
    !protectedContentApproved ||
    (state.change_scope.passed !== true && state.change_scope.split_required !== true);
  const autoFix =
    !allOk &&
    !humanRequired &&
    (unresolvedMustFixIds.length > 0 || state.validation.passed !== true || review.verdict === "fix_required");
  return {
    all_ok: allOk,
    auto_fix: autoFix,
    human_required: humanRequired,
    split_required: state.change_scope.split_required === true,
    checks,
    failures: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
    unresolved_must_fix: unresolvedMustFixIds,
    unresolved_high_risk: unresolvedHighIds,
    next_phase: allOk ? "ready_for_human" : humanRequired ? "human_required" : state.change_scope.split_required ? "split_required" : "plan",
    max_iterations_reached: exhausted,
  };
}

function escapeTable(value) {
  return String(value ?? "—").replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

function mention(value) {
  if (!value) return "—";
  const string = String(value);
  return string.startsWith("@") ? string : `@${string}`;
}

export function stateMarker(stateInput) {
  const state = initialState(stateInput);
  const compact = {
    version: state.version,
    issue: state.issue,
    unit: state.unit,
    units_index: state.units_index,
    phase: state.phase,
    iteration: state.iteration,
    branch: state.branch,
    pr: state.pr,
    assignee: state.assignee,
    reviewer: state.reviewer,
    agent: state.agent,
    plan: state.plan,
    reviewed_sha: state.reviewed_sha,
    current_sha: state.current_sha,
    all_ok: state.all_ok,
    problems: state.problems,
    validation: state.validation,
    protected_paths: state.protected_paths,
    change_scope: state.change_scope,
  };
  return `<!-- ${STATE_MARKER}\n${stableStringify(compact)}\n-->`;
}

export function parseStateComment(body) {
  const text = String(body ?? "");
  const markerIndex = text.indexOf(`<!-- ${STATE_MARKER}`);
  if (markerIndex < 0) return null;
  const jsonStart = text.indexOf("\n", markerIndex);
  const markerEnd = text.indexOf("-->", jsonStart);
  if (jsonStart < 0 || markerEnd < 0) return null;
  try {
    return initialState(JSON.parse(text.slice(jsonStart + 1, markerEnd).trim()));
  } catch {
    return null;
  }
}

export function renderProgress(stateInput) {
  const state = initialState(stateInput);
  const rows = state.problems.length
    ? state.problems.map((problem) =>
        `| ${escapeTable(problem.id)} | ${escapeTable(problem.problem)} | ${escapeTable(problem.risk)} | ${escapeTable(problem.status)} | ${escapeTable(problem.evidence)} | ${escapeTable(mention(problem.owner))} | ${escapeTable(problem.next_step)} |`,
      )
    : ["| — | 등록된 Problem 없음 | — | OPEN | — | — | 분석 대기 |"];
  const heading = state.unit
    ? `### Agent 진행 현황 — Unit ${state.unit} · Iteration ${state.iteration}`
    : `### Agent 진행 현황 — Iteration ${state.iteration}`;
  const unitsTable = state.units_index.length
    ? [
        "",
        `이 Issue는 ${state.units_index.length}개의 독립적인 semantic-unit PR로 분할되었습니다:`,
        "",
        "| Unit | 제목 | Branch | PR |",
        "|---|---|---|---|",
        ...state.units_index.map(
          (unit) =>
            `| ${escapeTable(unit.id)} | ${escapeTable(unit.title)} | \`${unit.branch ?? "—"}\` | ${unit.pr ? `#${unit.pr}` : "생성 대기"} |`,
        ),
      ]
    : [];
  return [
    heading,
    "",
    "| ID | Problem | Risk | 상태 | 근거/변경 | 담당 | 다음 단계 |",
    "|---|---|---:|---|---|---|---|",
    ...rows,
    ...unitsTable,
    "",
    `현재 단계: \`${state.phase}\`${state.all_ok ? " · **All OK**" : ""}`,
    `변경 범위: **${state.change_scope.split_required ? "split required" : state.change_scope.passed ? "passed" : "blocked"}** · ${state.change_scope.changed_lines} lines · target ${state.change_scope.target}, max ${state.change_scope.maximum} · \`${state.change_scope.reason}\``,
    "",
    stateMarker(state),
  ].join("\n");
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    env: options.env ?? process.env,
    input: options.input,
  });
  if (result.error) {
    if (options.allowMissing && result.error.code === "ENOENT") return { status: 127, stdout: "", stderr: result.error.message };
    throw new PipelineError(`${command} failed to start: ${result.error.message}`, "PROCESS_FAILED");
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new PipelineError(`${command} ${args.join(" ")} failed: ${String(result.stderr).trim()}`, "PROCESS_FAILED", { status: result.status });
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(repo, args, options = {}) {
  return runProcess("git", args, { cwd: repo, ...options });
}

function languageFor(filePath) {
  const extension = extname(filePath).toLowerCase();
  return {
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".java": "java",
    ".kt": "kotlin",
    ".c": "c",
    ".h": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".swift": "swift",
    ".php": "php",
    ".sh": "shell",
  }[extension] ?? "text";
}

function extractImportSpecifiers(source, language) {
  const values = [];
  const patterns = [];
  if (["javascript", "typescript"].includes(language)) {
    patterns.push(/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g, /(?:require|import)\(\s*["']([^"']+)["']\s*\)/g);
  } else if (language === "python") {
    patterns.push(/^\s*from\s+([.\w]+)\s+import\s+/gm, /^\s*import\s+([\w.]+)/gm);
  } else if (language === "ruby") patterns.push(/^\s*require_relative\s+["']([^"']+)["']/gm);
  else if (["c", "cpp"].includes(language)) patterns.push(/^\s*#\s*include\s+"([^"]+)"/gm);
  else if (language === "rust") patterns.push(/^\s*mod\s+([a-zA-Z_][\w]*)\s*;/gm);
  else if (language === "go") patterns.push(/["`]([^"`]+)["`]/g);
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) values.push(match[1]);
  }
  return unique(values);
}

function resolveImport(sourcePath, specifier, tracked) {
  const language = languageFor(sourcePath);
  let base;
  if (specifier.startsWith(".")) base = posix.normalize(posix.join(posix.dirname(sourcePath), specifier));
  else if (language === "python") base = specifier.replaceAll(".", "/");
  else if (["c", "cpp", "ruby"].includes(language)) base = posix.normalize(posix.join(posix.dirname(sourcePath), specifier));
  else if (language === "rust") base = posix.join(posix.dirname(sourcePath), `${specifier}.rs`);
  else return null;
  base = normalizeRepoPath(base);
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".h", ".hpp"];
  const candidates = extensions.flatMap((extension) => [`${base}${extension}`, `${base}/index${extension}`]);
  return candidates.find((candidate) => tracked.has(candidate)) ?? null;
}

function ownersForPath(team, filePath) {
  return team.people
    .filter((person) => person.active !== false && asArray(person.responsibilities?.paths).some((pattern) => matchesGlob(filePath, pattern)))
    .map((person) => person.github);
}

function identityForAuthor(team, name, email) {
  const normalizedName = lower(name).replace(/\s+/g, "");
  const emailLocal = lower(email).split("@")[0];
  const person = team.people.find((candidate) => {
    const login = lower(candidate.github);
    return login === normalizedName || login === emailLocal || normalizedName.includes(login.replace(/[-_]/g, ""));
  });
  return person?.github ?? (emailLocal || normalizedName || "unknown");
}

function relatedFilesWithRg(repo, files, issue) {
  if (!issue) return new Map();
  const text = issueText(issue);
  const tokens = unique((text.match(/[\p{L}\p{N}_-]{3,}/gu) ?? []).map(lower))
    .filter((token) => !new Set(["the", "and", "for", "with", "this", "that", "from", "expected", "actual", "problem"]).has(token))
    .slice(0, 8);
  const scores = new Map();
  for (const token of tokens) {
    const result = runProcess("rg", ["--files-with-matches", "--ignore-case", "--fixed-strings", "--", token, "."], {
      cwd: repo,
      allowFailure: true,
      allowMissing: true,
    });
    if (result.status === 0) {
      for (const filePath of String(result.stdout).split(/\r?\n/).filter(Boolean)) {
        const normalizedPath = normalizeRepoPath(filePath);
        if (files.includes(normalizedPath)) scores.set(normalizedPath, (scores.get(normalizedPath) ?? 0) + 1);
      }
    }
  }
  return scores;
}

function testEdges(files) {
  const sourceFiles = files.filter((filePath) => !/(^|\/)(?:test|tests|__tests__)(\/|$)|(?:\.test|\.spec|_test)\./i.test(filePath));
  const byStem = new Map();
  for (const filePath of sourceFiles) {
    const stem = basename(filePath, extname(filePath)).toLowerCase();
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(filePath);
  }
  const edges = [];
  for (const filePath of files) {
    if (!/(^|\/)(?:test|tests|__tests__)(\/|$)|(?:\.test|\.spec|_test)\./i.test(filePath)) continue;
    const stem = basename(filePath, extname(filePath)).replace(/(?:\.test|\.spec|_test)$/i, "").replace(/^test[_-]/i, "").toLowerCase();
    for (const sourcePath of (byStem.get(stem) ?? []).slice(0, 5)) {
      edges.push({ from: `file:${filePath}`, to: `file:${sourcePath}`, type: "tests", confidence: 0.8 });
    }
  }
  return edges;
}

/** Builds the bounded file/dependency/ownership graph described by team.yaml. */
export function buildCodegraph(team, options = {}) {
  const repo = resolve(options.repo ?? ".");
  const maxFiles = Math.max(1, asInteger(options.max_files, team.pipeline?.codegraph?.max_files ?? 5000));
  const listed = git(repo, ["ls-files", "-z"]).stdout.split("\0").filter(Boolean).map(normalizeRepoPath);
  const truncated = listed.length > maxFiles;
  const files = listed.slice(0, maxFiles);
  const tracked = new Set(files);
  const nodes = [];
  const edges = [];
  const churn = new Map();
  const recentByFile = new Map();
  const lookbackDays = Math.max(1, asInteger(team.pipeline?.codegraph?.blame_lookback_days, 365));
  const log = git(repo, ["log", `--since=${lookbackDays}.days`, "--format=@@%aN|%aE", "--name-only", "--no-renames"], { allowFailure: true }).stdout;
  let author = null;
  let seenInCommit = new Set();
  const flushCommit = () => {
    if (!author) return;
    for (const filePath of seenInCommit) {
      churn.set(filePath, (churn.get(filePath) ?? 0) + 1);
      const key = `${author}|${filePath}`;
      recentByFile.set(key, (recentByFile.get(key) ?? 0) + 1);
    }
  };
  for (const line of String(log).split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      flushCommit();
      author = line.slice(2);
      seenInCommit = new Set();
    } else if (line.trim() && tracked.has(normalizeRepoPath(line))) seenInCommit.add(normalizeRepoPath(line));
  }
  flushCommit();

  for (const filePath of files) {
    const owners = ownersForPath(team, filePath);
    nodes.push({ id: `file:${filePath}`, type: "file", path: filePath, language: languageFor(filePath), owners, churn: churn.get(filePath) ?? 0 });
    for (const owner of owners) edges.push({ from: `person:${owner}`, to: `file:${filePath}`, type: "owns", confidence: 1, github: owner });
    const absolute = join(repo, ...filePath.split("/"));
    let source = "";
    try {
      if (readFileSync(absolute).byteLength <= 512 * 1024) source = readFileSync(absolute, "utf8");
    } catch {
      source = "";
    }
    if (source.includes("\0")) continue;
    for (const specifier of extractImportSpecifiers(source, languageFor(filePath))) {
      const target = resolveImport(filePath, specifier, tracked);
      if (target) edges.push({ from: `file:${filePath}`, to: `file:${target}`, type: "imports", confidence: 0.95, specifier });
    }
  }
  edges.push(...testEdges(files));

  for (const [key, weight] of recentByFile) {
    const separator = key.lastIndexOf("|");
    const rawAuthor = key.slice(0, separator);
    const filePath = key.slice(separator + 1);
    const [name, email = ""] = rawAuthor.split("|");
    const identity = identityForAuthor(team, name, email);
    edges.push({ from: `person:${identity}`, to: `file:${filePath}`, type: "recent_commit", weight, github: identity });
  }

  const related = relatedFilesWithRg(repo, files, options.issue);
  const issueNumber = options.issue?.issue?.number ?? options.issue?.number ?? null;
  if (issueNumber) nodes.push({ id: `issue:${issueNumber}`, type: "issue", number: issueNumber });
  for (const [filePath, hits] of related) {
    if (issueNumber) edges.push({ from: `issue:${issueNumber}`, to: `file:${filePath}`, type: "related", confidence: Math.min(1, 0.4 + hits * 0.1), hits });
  }

  const requestedBlame = readPaths(options.blame_files ?? options.changed_files);
  const blameFiles = unique([...requestedBlame, ...[...related.keys()].slice(0, 25)]).filter((filePath) => tracked.has(filePath)).slice(0, 50);
  const cutoff = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
  for (const filePath of blameFiles) {
    const blame = git(repo, ["blame", "--line-porcelain", "--", filePath], { allowFailure: true }).stdout;
    let name = "";
    let email = "";
    let timestamp = 0;
    const counts = new Map();
    for (const line of String(blame).split(/\r?\n/)) {
      if (line.startsWith("author ")) name = line.slice(7);
      else if (line.startsWith("author-mail ")) email = line.slice(12).replace(/^<|>$/g, "");
      else if (line.startsWith("author-time ")) timestamp = asInteger(line.slice(12), 0);
      else if (line.startsWith("\t") && timestamp >= cutoff) {
        const identity = identityForAuthor(team, name, email);
        counts.set(identity, (counts.get(identity) ?? 0) + 1);
      }
    }
    for (const [identity, lines] of counts) edges.push({ from: `person:${identity}`, to: `file:${filePath}`, type: "blame", lines, weight: lines, github: identity });
  }

  return {
    version: PIPELINE_VERSION,
    repository: basename(repo),
    limits: { max_files: maxFiles, blame_lookback_days: lookbackDays },
    truncated,
    file_count: files.length,
    nodes,
    edges,
  };
}

export function changedFilesFromPatch(source) {
  const paths = [];
  for (const line of String(source).split(/\r?\n/)) {
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (match) {
      const before = normalizeRepoPath(match[1]);
      const after = normalizeRepoPath(match[2]);
      paths.push(before, after);
    }
  }
  return unique(paths);
}

/** Enforces the cumulative PR line budget without trusting model metadata. */
export function evaluateChangeScope(team, patchInput) {
  const policy = team.pipeline?.change_scope ?? {};
  const target = asInteger(policy.target_pr_changed_lines, 0);
  const maximum = asInteger(policy.max_pr_changed_lines, 0);
  invariant(
    policy.commit_unit === "single_crud_bundle" && policy.pr_unit === "single_semantic_unit" && target > 0 && maximum >= target,
    "Invalid pipeline.change_scope policy",
    "INVALID_TEAM_POLICY",
  );
  let additions = 0;
  let deletions = 0;
  let binary = false;
  for (const line of String(patchInput).split(/\r?\n/)) {
    if (line === "GIT binary patch" || line.startsWith("Binary files ")) binary = true;
    else if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  const changedLines = additions + deletions;
  const splitRequired = !binary && changedLines > maximum;
  const passed = !binary && changedLines > 0 && !splitRequired;
  const reason = binary
    ? "binary_line_count_unknown"
    : changedLines === 0
      ? "empty_diff"
      : splitRequired
        ? "above_maximum_split_required"
        : changedLines < target
          ? "below_target_allowed"
          : "within_target";
  return {
    passed,
    human_required: binary || changedLines === 0,
    split_required: splitRequired,
    recommended_pr_count: splitRequired ? Math.ceil(changedLines / maximum) : 1,
    commit_unit: policy.commit_unit,
    pr_unit: policy.pr_unit,
    additions,
    deletions,
    changed_lines: changedLines,
    target,
    maximum,
    binary,
    reason,
  };
}

export function createPatch(options = {}) {
  const repo = resolve(options.repo ?? ".");
  const base = String(options.base ?? "HEAD");
  const tracked = git(repo, ["diff", "--binary", "--full-index", base, "--"]).stdout;
  const untracked = git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout.split("\0").filter(Boolean);
  const parts = [tracked];
  for (const filePath of untracked) {
    const diff = git(repo, ["diff", "--no-index", "--binary", "--", "/dev/null", filePath], { allowFailure: true }).stdout;
    if (diff) parts.push(diff);
  }
  const patch = parts.filter(Boolean).join(parts.filter(Boolean).length > 1 ? "\n" : "");
  return { patch, changed_paths: changedFilesFromPatch(patch), untracked: untracked.map(normalizeRepoPath), base };
}

function repositoryParts(repository = process.env.GITHUB_REPOSITORY) {
  const match = String(repository ?? "").match(/^([^/]+)\/([^/]+)$/);
  invariant(match, "GITHUB_REPOSITORY must be owner/name", "INVALID_GITHUB_ENV");
  return { owner: match[1], repo: match[2] };
}

export class GitHubClient {
  constructor(options = {}) {
    this.token = options.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    this.repository = options.repository ?? process.env.GITHUB_REPOSITORY;
    this.apiUrl = String(options.api_url ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
    this.graphqlUrl = String(options.graphql_url ?? process.env.GITHUB_GRAPHQL_URL ?? `${this.apiUrl}/graphql`);
    this.appId = String(options.app_id ?? process.env.AGENT_APP_ID ?? "");
    this.botLogin = lower(options.bot_login ?? process.env.AGENT_APP_BOT_LOGIN ?? "");
    this.fetch = options.fetch ?? globalThis.fetch;
    invariant(this.token, "GH_TOKEN is required for GitHub operations", "MISSING_GITHUB_TOKEN");
    invariant(typeof this.fetch === "function", "This Node runtime does not provide fetch", "MISSING_FETCH");
    repositoryParts(this.repository);
  }

  repoPath(suffix) {
    const { owner, repo } = repositoryParts(this.repository);
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
  }

  async request(method, path, options = {}) {
    const url = path.startsWith("http://") || path.startsWith("https://") ? path : `${this.apiUrl}${path}`;
    const headers = {
      Accept: options.accept ?? "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "issue-review-agent-pipeline/v1",
      ...options.headers,
    };
    const response = await this.fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const raw = await response.text();
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }
    const allowed = new Set(options.allow_statuses ?? []);
    if (!response.ok && !allowed.has(response.status)) {
      const message = isObject(data) ? data.message : String(data ?? response.statusText);
      throw new PipelineError(`GitHub API ${method} ${path} failed (${response.status}): ${message}`, "GITHUB_API_ERROR", {
        status: response.status,
        documentation_url: isObject(data) ? data.documentation_url : undefined,
      });
    }
    return { status: response.status, data, headers: response.headers };
  }

  async paginate(path, limitPages = 10) {
    const separator = path.includes("?") ? "&" : "?";
    const values = [];
    for (let page = 1; page <= limitPages; page += 1) {
      const response = await this.request("GET", `${path}${separator}per_page=100&page=${page}`);
      const items = Array.isArray(response.data) ? response.data : [];
      values.push(...items);
      if (items.length < 100) break;
    }
    return values;
  }
}

/** Rechecks the mutable GitHub objects that a write-capable publisher will use. */
export async function validateLivePublication(client, input = {}) {
  const repositoryName = String(client.repository ?? process.env.GITHUB_REPOSITORY ?? "");
  const { owner } = repositoryParts(repositoryName);
  const repository = await client.request("GET", client.repoPath(""));
  const defaultBranch = String(repository.data?.default_branch ?? "");
  invariant(defaultBranch, "GitHub did not return the default branch", "GITHUB_API_ERROR");
  const state = initialState(input.state ?? {});
  const branch = String(input.branch ?? state.branch ?? "");
  const prNumber = asInteger(input.pr ?? input.pr_number ?? state.pr, 0) || null;
  const expectedHead = String(input.expected_head_sha ?? input.gate?.head_sha ?? (prNumber ? state.current_sha ?? "" : ""));
  const expectedBase = String(input.expected_base_sha ?? input.gate?.base_sha ?? input.gate?.checkout_ref ?? (!prNumber ? state.current_sha ?? "" : ""));
  let pull = null;

  if (prNumber) {
    const response = await client.request("GET", client.repoPath(`/pulls/${prNumber}`));
    pull = response.data;
  } else if (branch) {
    const response = await client.request(
      "GET",
      client.repoPath(`/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(defaultBranch)}&per_page=100`),
    );
    const matches = asArray(response.data);
    invariant(matches.length <= 1, "More than one PR exists for the canonical agent branch", "UNSAFE_PR_LIFECYCLE");
    pull = matches[0] ?? null;
  }

  if (pull) {
    invariant(lower(pull.state) === "open" && pull.merged !== true, "Canonical PR is closed or merged", "UNSAFE_PR_LIFECYCLE");
    invariant(pull.base?.repo?.full_name === repositoryName, "PR base repository is not canonical", "UNSAFE_PR_BASE");
    invariant(pull.head?.repo?.full_name === repositoryName, "PR head repository is not canonical", "UNSAFE_PR_HEAD");
    invariant(String(pull.base?.ref ?? "") === defaultBranch, "PR base is not the current default branch", "UNSAFE_PR_BASE");
    invariant(!branch || String(pull.head?.ref ?? "") === branch, "PR head branch changed", "UNSAFE_PR_HEAD");
    invariant(!expectedHead || String(pull.head?.sha ?? "") === expectedHead, "PR head SHA changed", "STALE_HEAD");
    invariant(!expectedBase || String(pull.base?.sha ?? "") === expectedBase, "PR base SHA changed", "STALE_BASE");
  } else {
    invariant(!prNumber, "Canonical PR no longer exists", "UNSAFE_PR_LIFECYCLE");
    const commit = await client.request("GET", client.repoPath(`/commits/${encodeURIComponent(defaultBranch)}`));
    invariant(!expectedBase || String(commit.data?.sha ?? "") === expectedBase, "Default branch changed after verification", "STALE_BASE");
  }

  return {
    passed: true,
    repository: repositoryName,
    default_branch: defaultBranch,
    branch,
    pr: pull?.number ?? null,
    pull,
    expected_head_sha: expectedHead || null,
    expected_base_sha: expectedBase || null,
  };
}

/**
 * Locates the canonical state comment for an Issue. An Issue may carry more
 * than one canonical thread once it has been split into independent
 * semantic-unit PRs (one comment per unit, plus the original overview
 * comment at `unit: null`). Callers that know which PR/branch/unit they are
 * acting on should pass a disambiguator; callers with no PR context (e.g. a
 * bare `/agent resume` on the Issue) always resolve to the `unit: null`
 * overview thread so they never land on an arbitrary unit.
 */
export async function findStateComment(client, issueNumber, options = {}) {
  invariant(issueNumber, "An issue number is required to load state", "INVALID_ARGUMENT");
  const comments = await client.paginate(client.repoPath(`/issues/${issueNumber}/comments`));
  invariant(client.appId || client.botLogin, "AGENT_APP_ID or AGENT_APP_BOT_LOGIN is required to trust canonical state comments", "MISSING_APP_IDENTITY");
  const candidates = comments
    .filter((comment) => {
      if (client.appId) return String(comment.performed_via_github_app?.id ?? "") === client.appId;
      return lower(comment.user?.login) === client.botLogin && lower(comment.user?.type) === "bot";
    })
    .map((comment) => ({ comment, state: parseStateComment(comment.body) }))
    .filter((candidate) => candidate.state)
    .sort((left, right) => String(right.comment.updated_at ?? "").localeCompare(String(left.comment.updated_at ?? "")) || right.comment.id - left.comment.id);
  const hasPr = options.pr !== undefined && options.pr !== null && options.pr !== "";
  const hasBranch = Boolean(options.branch);
  const hasUnit = options.unit !== undefined;
  let scoped = candidates;
  if (hasPr) {
    const prNumber = asInteger(options.pr, 0);
    scoped = candidates.filter((candidate) => candidate.state.pr === prNumber);
  } else if (hasBranch) {
    scoped = candidates.filter((candidate) => candidate.state.branch === String(options.branch));
  } else if (hasUnit) {
    const unit = normalizeUnitId(options.unit);
    scoped = candidates.filter((candidate) => candidate.state.unit === unit);
  } else {
    const overview = candidates.filter((candidate) => candidate.state.unit === null);
    scoped = overview.length ? overview : candidates;
  }
  return scoped[0] ?? null;
}

export async function loadState(client, options = {}) {
  const event = options.event ?? {};
  let pr = event.pull_request ?? null;
  const prNumber = asInteger(options.pr ?? pr?.number ?? (event.issue?.pull_request ? event.issue.number : 0), 0) || null;
  if (!pr && prNumber) {
    const response = await client.request("GET", client.repoPath(`/pulls/${prNumber}`));
    pr = response.data;
  }
  const issueNumber =
    asInteger(options.issue, 0) ||
    event.issue?.number ||
    sourceIssueFromPullRequest(pr) ||
    asInteger(options.source_issue_number, 0) ||
    null;
  invariant(issueNumber, "Could not determine the source issue number", "MISSING_ISSUE_NUMBER");
  const found = await findStateComment(client, issueNumber, { pr: prNumber, branch: pr?.head?.ref ?? options.branch, unit: options.unit });
  if (found) {
    const review = event.review;
    const association = String(review?.author_association ?? "NONE").toUpperCase();
    const reviewer = review?.user;
    const reviewedSha = String(review?.commit_id ?? "");
    const currentSha = String(pr?.head?.sha ?? "");
    const trustedApproval =
      event.action === "submitted" &&
      lower(review?.state) === "approved" &&
      WRITE_ASSOCIATIONS.has(association) &&
      Boolean(found.state.reviewer) &&
      lower(found.state.reviewer) === lower(reviewer?.login) &&
      lower(reviewer?.type) !== "bot" &&
      !/\[bot\]$/i.test(String(reviewer?.login ?? "")) &&
      Boolean(reviewedSha) &&
      reviewedSha === currentSha;
    const resolvesHumanProblems = found.state.problems.some((problem) => problem.status === "HUMAN_REQUIRED");
    const approvesProtectedContent = found.state.protected_paths.matched.length > 0;
    if (trustedApproval && (resolvesHumanProblems || approvesProtectedContent)) {
      return mergeState(found.state, {
        all_ok: false,
        current_sha: currentSha,
        reviewed_sha: null,
        phase: "review",
        protected_paths: {
          ...found.state.protected_paths,
          content_approved_by: reviewer.login,
          content_approved_sha: reviewedSha,
        },
        problems: found.state.problems.map((problem) =>
          problem.status === "HUMAN_REQUIRED"
            ? {
                ...problem,
                status: "FIXED",
                evidence: `${problem.evidence}; approved by @${reviewer.login} at ${reviewedSha.slice(0, 12)}`,
                next_step: "Fresh agent review",
              }
            : problem,
        ),
      });
    }
    return found.state;
  }
  return initialState({
      issue: issueNumber,
      unit: options.unit ?? null,
      pr: prNumber,
      branch: pr?.head?.ref ?? options.branch ?? "",
      current_sha: pr?.head?.sha ?? options.current_sha ?? "",
    });
}

export async function upsertStateComment(client, issueNumber, stateInput, prefix = "") {
  const state = initialState({ ...stateInput, issue: issueNumber });
  const body = [String(prefix ?? "").trim(), renderProgress(state)].filter(Boolean).join("\n\n");
  const existing = await findStateComment(client, issueNumber, { pr: state.pr, branch: state.branch, unit: state.unit });
  const response = existing
    ? await client.request("PATCH", client.repoPath(`/issues/comments/${existing.comment.id}`), { body: { body } })
    : await client.request("POST", client.repoPath(`/issues/${issueNumber}/comments`), { body: { body } });
  return {
    action: existing ? "updated" : "created",
    comment_id: response.data?.id ?? existing?.comment?.id ?? null,
    comment_url: response.data?.html_url ?? existing?.comment?.html_url ?? null,
    state,
  };
}

async function addLabels(client, issueNumber, labels) {
  const normalized = unique(asArray(labels).map(String).filter(Boolean));
  if (!normalized.length) return [];
  for (const label of normalized) {
    const metadata = MANAGED_LABELS[label];
    if (!metadata) continue;
    const existing = await client.request("GET", client.repoPath(`/labels/${encodeURIComponent(label)}`), { allow_statuses: [404] });
    if (existing.status === 404) {
      // A concurrent run may create the same fixed label between GET and POST;
      // 422 is therefore an expected, safe race rather than a pipeline failure.
      await client.request("POST", client.repoPath("/labels"), {
        body: { name: label, ...metadata },
        allow_statuses: [422],
      });
    }
  }
  const response = await client.request("POST", client.repoPath(`/issues/${issueNumber}/labels`), {
    body: { labels: normalized },
    allow_statuses: [404, 422],
  });
  return response.status >= 200 && response.status < 300 ? asArray(response.data).map((label) => label.name ?? label) : [];
}

async function isAssignable(client, login) {
  const response = await client.request("GET", client.repoPath(`/assignees/${encodeURIComponent(login)}`), { allow_statuses: [404] });
  return response.status === 204;
}

async function assignUsers(client, issueNumber, candidates, maxCount) {
  const assignable = [];
  const skipped = [];
  for (const login of unique(asArray(candidates).map(String)).slice(0, maxCount)) {
    if (/\[bot\]$/i.test(login) || !(await isAssignable(client, login))) skipped.push(login);
    else assignable.push(login);
  }
  if (assignable.length) await client.request("POST", client.repoPath(`/issues/${issueNumber}/assignees`), { body: { assignees: assignable } });
  return { assigned: assignable, skipped };
}

async function requestReviewer(client, prNumber, reviewer) {
  if (!reviewer || /\[bot\]$/i.test(reviewer)) return { requested: null, skipped: reviewer ?? null };
  const response = await client.request("POST", client.repoPath(`/pulls/${prNumber}/requested_reviewers`), {
    body: { reviewers: [reviewer] },
    allow_statuses: [422],
  });
  return response.status === 422 ? { requested: null, skipped: reviewer } : { requested: reviewer, skipped: null };
}

async function postComment(client, issueNumber, body) {
  if (!String(body ?? "").trim()) return null;
  const response = await client.request("POST", client.repoPath(`/issues/${issueNumber}/comments`), { body: { body: String(body) } });
  return { id: response.data?.id ?? null, url: response.data?.html_url ?? null };
}

function publisherState(input, patch = {}) {
  return mergeState(input.state ?? input, patch);
}

async function hydratedPublisherState(client, issue, input, patch = {}) {
  const supplied = input.state ?? input;
  const found = await findStateComment(client, issue, {
    pr: patch.pr ?? supplied.pr,
    branch: patch.branch ?? supplied.branch,
    unit: patch.unit ?? supplied.unit,
  });
  if (!found) return mergeState(supplied, patch);
  const base = found.state;
  return mergeState(base, {
    ...supplied,
    assignee: supplied.assignee ?? base.assignee,
    reviewer: supplied.reviewer ?? base.reviewer,
    agent: supplied.agent ?? base.agent,
    plan: supplied.plan ?? base.plan,
    problems: supplied.problems?.length ? supplied.problems : base.problems,
    branch: supplied.branch ?? base.branch,
    pr: supplied.pr ?? base.pr,
    unit: supplied.unit ?? base.unit,
    units_index: supplied.units_index?.length ? supplied.units_index : base.units_index,
    ...patch,
  });
}

async function publishApprovalRequired(client, input) {
  const issue = asInteger(input.issue ?? input.issue_number ?? input.state?.issue, 0);
  invariant(issue, "approval-required requires issue", "INVALID_PUBLISH_INPUT");
  const state = publisherState(input, { issue, phase: "human_approval", all_ok: false });
  await addLabels(client, issue, ["agent:approval-required"]);
  const comment = await upsertStateComment(
    client,
    issue,
    state,
    input.body ?? "외부 기여자의 Issue이므로 write-capable agent 실행 전에 maintainer의 `agent:approved` 승인이 필요합니다.",
  );
  return { operation: "approval-required", issue, labels: ["agent:approval-required"], comment };
}

async function publishProtectedApprovalRequired(client, input) {
  const authorization = input.authorization ?? input.protected ?? input;
  const issue = asInteger(input.issue ?? authorization.issue ?? input.state?.issue, 0);
  invariant(issue, "protected-approval-required requires issue", "INVALID_PUBLISH_INPUT");
  const state = publisherState(input, {
    issue,
    phase: "human_required",
    all_ok: false,
    protected_paths: authorization,
  });
  await addLabels(client, issue, ["agent:human-required"]);
  const requested = asArray(authorization.requested).length ? asArray(authorization.requested) : asArray(authorization.matched);
  const marker = requested.length ? `<!-- ${PROTECTED_REQUEST_MARKER} ${JSON.stringify({ paths: requested })} -->` : null;
  const command =
    requested.length && authorization.reason !== "workflow_definition_requires_manual_change"
      ? `${PROTECTED_APPROVAL_PREFIX}${JSON.stringify({ issue, paths: requested })}`
      : null;
  const eligibility = asArray(authorization.eligible_reviewers);
  const prefix = [
    "Protected path 자동 변경을 중단했습니다.",
    `사유: \`${authorization.reason ?? "authorization_required"}\``,
    authorization.reason === "workflow_definition_requires_manual_change"
      ? "`.github/workflows/**` 변경은 이 단일 workflow MVP에서 자동 게시할 수 없습니다. 사람이 별도 브랜치에서 직접 변경해야 합니다."
      : null,
    marker ? `Source Issue body에는 다음 marker가 정확히 한 번 있어야 합니다:\n\n\`${marker}\`` : null,
    command
      ? `구현 담당자가 아니며 해당 경로를 담당하는 ${
          eligibility.length ? `reviewer(${eligibility.map((login) => `@${login}`).join(", ")})` : "적격 reviewer"
        }가 다음 전체 comment를 그대로 제출해야 합니다:\n\n\`${command}\``
      : null,
    authorization.reason === "no_eligible_protected_reviewer"
      ? "현재 team policy에는 구현 담당자와 분리된 적격 protected-path reviewer가 없습니다."
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  const comment = await upsertStateComment(client, issue, state, input.body ?? prefix);
  const pr = asInteger(input.pr ?? input.pr_number ?? state.pr, 0) || null;
  let prComment = null;
  if (pr) {
    await addLabels(client, pr, ["agent:human-required"]);
    prComment = await postComment(
      client,
      pr,
      [input.body ?? prefix, renderProgress(state), comment.comment_url ? `[Canonical progress](${comment.comment_url})` : null]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  return {
    operation: "protected-approval-required",
    issue,
    pr,
    labels: ["agent:human-required"],
    human_required: true,
    reason: authorization.reason ?? "authorization_required",
    comment,
    pr_comment: prComment,
  };
}

async function publishAnalysis(client, input) {
  const issue = asInteger(input.issue ?? input.issue_number ?? input.state?.issue, 0);
  invariant(issue, "analysis requires issue", "INVALID_PUBLISH_INPUT");
  const selectedAssignee = input.assignee ?? input.owner?.assignee ?? input.state?.assignee ?? null;
  const selectedAgent = input.owner?.agent ?? input.triage?.agent ?? input.state?.agent ?? null;
  const assignments = await assignUsers(
    client,
    issue,
    input.assignees ?? selectedAssignee,
    asInteger(input.max_assignees ?? input.owner?.max_assignees, 1),
  );

  const proposedUnits = asArray(input.reconciliation?.units);
  const split = input.reconciliation?.split === true && proposedUnits.length > 1;
  if (split) {
    const unitsIndex = proposedUnits.map((unit) => ({ id: unit.id, title: unit.title, branch: unit.branch, pr: null }));
    const overviewState = publisherState(input, {
      issue,
      unit: null,
      phase: "split_required",
      assignee: selectedAssignee,
      agent: selectedAgent,
      plan: null,
      problems: [],
      units_index: unitsIndex,
    });
    const overview = await upsertStateComment(
      client,
      issue,
      overviewState,
      input.body ??
        `이 Issue는 예상 변경 규모(semantic unit ${proposedUnits.length}개)로 인해 독립적인 PR ${proposedUnits.length}개로 분할되었습니다. 각 unit은 자체 진행 현황 코멘트와 브랜치/PR을 가지며 서로 독립적으로 검토·병합됩니다.`,
    );
    const units = [];
    for (const unit of proposedUnits) {
      const unitState = publisherState(input, {
        issue,
        unit: unit.id,
        branch: unit.branch,
        phase: "plan",
        assignee: selectedAssignee,
        agent: selectedAgent,
        plan: unit,
        problems: unit.problems,
        iteration: unit.iteration,
        validation: {
          passed: false,
          commands: unit.validation_commands.map((command) => ({ command, passed: false, exit_code: null })),
        },
      });
      const comment = await upsertStateComment(client, issue, unitState, `**Unit ${unit.id} — ${unit.title}**`);
      units.push({ unit: unit.id, branch: unit.branch, comment });
    }
    return { operation: "analysis", issue, assignments, split: true, overview, units };
  }

  const state = publisherState(input, {
    issue,
    phase: input.phase ?? "plan",
    assignee: selectedAssignee,
    agent: selectedAgent,
    plan: input.plan ?? input.state?.plan ?? null,
    problems: input.plan?.problems ?? input.state?.problems,
  });
  const comment = await upsertStateComment(client, issue, state, input.body ?? input.summary ?? "");
  return { operation: "analysis", issue, assignments, split: false, comment };
}

function gitAuthenticationEnv(token) {
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: header,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function gitStatusPaths(repo) {
  const output = git(repo, ["status", "--porcelain=v1", "-z"]).stdout;
  const entries = output.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    invariant(entry.length >= 3, "Malformed git status record", "PROCESS_FAILED");
    const status = entry.slice(0, 2);
    paths.push(normalizeRepoPath(entry.slice(3)));
    // In porcelain v1 -z, a rename/copy record is followed by a second NUL
    // field containing the original path and no XY prefix.
    if (/[RC]/.test(status) && index + 1 < entries.length) paths.push(normalizeRepoPath(entries[++index]));
  }
  return unique(paths);
}

export function renderPullRequestBody(input, stateInput, issueNumber) {
  const state = initialState(stateInput);
  const plan = input.plan ?? state.plan ?? {};
  const changed = unique(readPaths(input.changed_paths)).sort();
  const risk = normalizeRisk(input.risk?.risk ?? input.risk ?? plan.risk, true);
  const steps = asArray(plan.steps);
  const validations = state.validation.commands;
  return [
    `Closes #${issueNumber}`,
    "",
    "## 구현 계획",
    "",
    ...(steps.length ? steps.map((step, index) => `${index + 1}. ${String(step)}`) : ["- 저장된 구현 계획이 없습니다. canonical Issue 상태를 확인하세요."]),
    "",
    "## 변경 파일",
    "",
    ...(changed.length ? changed.map((filePath) => `- \`${filePath}\``) : ["- 변경 파일 정보 없음"]),
    "",
    "## 검증",
    "",
    ...(validations.length
      ? validations.map((validation) => `- ${validation.passed ? "✅" : "❌"} \`${validation.command}\` (exit ${validation.exit_code ?? "unknown"})`)
      : ["- 검증 결과 없음"]),
    "",
    "## 위험도",
    "",
    `- 최종 위험도: **${risk}**`,
    `- Protected path 정책: **${state.protected_paths.passed ? "passed" : "blocked"}**`,
    `- 변경 범위: **${state.change_scope.split_required ? "split required" : state.change_scope.passed ? "passed" : "blocked"}** (${state.change_scope.changed_lines} lines; target ${state.change_scope.target}, max ${state.change_scope.maximum})`,
    state.protected_paths.matched.length ? `- 일치 경로: ${state.protected_paths.matched.map((filePath) => `\`${filePath}\``).join(", ")}` : null,
    "",
    `Agent iteration: ${state.iteration}`,
    "",
    "> 이 PR은 Draft로 생성되며 자동 merge되지 않습니다.",
  ].filter((line) => line !== null).join("\n");
}

async function publishPr(client, input) {
  const issue = asInteger(input.issue ?? input.issue_number ?? input.state?.issue, 0);
  invariant(issue, "pr requires issue", "INVALID_PUBLISH_INPUT");
  const branchPrefix = String(input.branch_prefix ?? "agent/issue-");
  const branch = String(input.branch ?? input.state?.branch ?? "");
  invariant(branch.startsWith(`${branchPrefix}${issue}`), `Branch must start with ${branchPrefix}${issue}`, "UNSAFE_BRANCH");
  invariant(!branch.includes("..") && !/\s/.test(branch), "Invalid branch name", "UNSAFE_BRANCH");
  const state = await hydratedPublisherState(client, issue, input, { issue, branch });
  invariant(state.validation.passed === true, "Refusing to publish a PR before validation passes", "VALIDATION_FAILED");
  invariant(state.protected_paths.passed === true, "Refusing to publish protected-path changes without approval", "PROTECTED_PATH");
  invariant(state.change_scope.passed === true, "Refusing to publish a PR outside the configured semantic line budget", "CHANGE_SCOPE_FAILED");
  const live = await validateLivePublication(client, { ...input, state, branch });
  let pr = live.pull;
  const reused = Boolean(pr);
  if (pr && pr.draft !== true) {
    invariant(pr.node_id, "GitHub did not return the PR node id", "GITHUB_API_ERROR");
    const converted = await client.request("POST", client.graphqlUrl, {
      body: {
        query: "mutation ConvertToDraft($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { number isDraft } } }",
        variables: { id: pr.node_id },
      },
    });
    invariant(!converted.data?.errors?.length, `GitHub GraphQL draft transition failed: ${converted.data?.errors?.[0]?.message ?? "unknown error"}`, "GITHUB_API_ERROR");
    pr = { ...pr, draft: true };
  }
  const repo = resolve(input.repo ?? ".");
  const worktreePaths = gitStatusPaths(repo);
  const declaredPaths = readPaths(input.changed_paths);
  if (declaredPaths.length) {
    const undeclared = worktreePaths.filter((filePath) => !declaredPaths.includes(filePath));
    invariant(!undeclared.length, `Worktree contains undeclared changes: ${undeclared.join(", ")}`, "UNDECLARED_CHANGES");
  }
  if (worktreePaths.length) {
    const paths = declaredPaths.length ? declaredPaths : worktreePaths;
    git(repo, ["add", "--", ...paths]);
    const staged = git(repo, ["diff", "--cached", "--quiet"], { allowFailure: true });
    if (staged.status !== 0) {
      const message = String(
        input.commit_message ?? `fix(agent): address issue #${issue}\n\nRefs #${issue}\nAgent-Iteration: ${state.iteration}`,
      );
      git(repo, [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=issue-review-agent[bot]",
        "-c",
        "user.email=issue-review-agent[bot]@users.noreply.github.com",
        "commit",
        "-m",
        message,
      ]);
    }
  }
  const sha = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  invariant(sha, "No commit is available to publish", "MISSING_COMMIT");
  if (input.push !== false) {
    git(repo, ["push", "origin", `HEAD:refs/heads/${branch}`], { env: gitAuthenticationEnv(client.token) });
  }

  const base = live.default_branch;
  const body = renderPullRequestBody(input, state, issue);
  if (!pr) {
    const title = String(input.title ?? `Fix #${issue}`);
    const created = await client.request("POST", client.repoPath("/pulls"), {
      body: { title, body, head: branch, base, draft: true },
    });
    pr = created.data;
  } else {
    const updated = await client.request("PATCH", client.repoPath(`/pulls/${pr.number}`), { body: { body } });
    pr = { ...pr, ...updated.data };
  }
  const prNumber = asInteger(pr?.number, 0);
  invariant(prNumber, "GitHub did not return a PR number", "GITHUB_API_ERROR");
  const assignments = await assignUsers(client, prNumber, input.assignees, asInteger(input.max_assignees, 3));
  const reviewer = await requestReviewer(client, prNumber, input.reviewer);
  const reviewerFailed = !reviewer.requested;
  const fallbackMention = input.fallback_mention ?? input.team?.fallback_mention ?? null;
  if (reviewerFailed) await addLabels(client, prNumber, ["agent:human-required"]);
  const protectedContentRequired = state.protected_paths.matched.length > 0;
  const committedProblems = state.problems
    .filter((problem) => problem.id !== PROTECTED_CONTENT_PROBLEM_ID)
    .map((problem) => ({
      ...problem,
      status: ["OPEN", "PLANNED", "IN_PROGRESS"].includes(problem.status) ? "FIXED" : problem.status,
      evidence: ["OPEN", "PLANNED", "IN_PROGRESS"].includes(problem.status) ? `commit ${sha.slice(0, 12)}` : problem.evidence,
      next_step: ["OPEN", "PLANNED", "IN_PROGRESS"].includes(problem.status) ? "Review" : problem.next_step,
    }));
  if (protectedContentRequired) {
    committedProblems.push(
      normalizeProblem(
        {
          id: PROTECTED_CONTENT_PROBLEM_ID,
          problem: "Protected 변경의 현재 PR head 콘텐츠 승인 필요",
          risk: "high",
          status: "HUMAN_REQUIRED",
          evidence: `${state.protected_paths.matched.join(", ")} at ${sha.slice(0, 12)}`,
          owner: reviewer.requested,
          next_step: "Selected reviewer must approve this exact PR head SHA",
        },
        committedProblems.length,
      ),
    );
    await addLabels(client, prNumber, ["agent:human-required"]);
  }
  const nextState = mergeState(state, {
    pr: prNumber,
    current_sha: sha,
    reviewed_sha: null,
    all_ok: false,
    phase: reviewerFailed || protectedContentRequired ? "human_required" : "review",
    reviewer: reviewer.requested,
    protected_paths: {
      ...state.protected_paths,
      content_approved_by: null,
      content_approved_sha: null,
    },
    problems: committedProblems,
  });
  const commentPrefix = reviewerFailed
    ? `Draft PR을 게시했지만 요청 가능한 reviewer가 없습니다. ${fallbackMention ?? "maintainer"}의 확인이 필요합니다.`
    : protectedContentRequired
      ? "Protected 변경이 포함되어 선택된 reviewer의 현재 head SHA 승인이 필요합니다."
    : input.summary ?? "Draft PR을 게시했습니다.";
  const comment = await upsertStateComment(client, issue, nextState, commentPrefix);
  const progress = renderProgress(nextState);
  const prSummary = await postComment(
    client,
    prNumber,
    [input.pr_summary, reviewerFailed ? `⚠️ reviewer 요청 실패 — ${fallbackMention ?? "maintainer"} 확인 필요` : null, progress]
      .filter((value) => value !== undefined && value !== null && value !== "")
      .join("\n\n"),
  );
  return {
    operation: "pr",
    issue,
    pr: prNumber,
    pr_url: pr.html_url ?? null,
    branch,
    sha,
    reused,
    assignments,
    reviewer,
    human_required: reviewerFailed || protectedContentRequired,
    comment,
    summary: prSummary,
  };
}

async function publishReview(client, input) {
  const issue = asInteger(input.issue ?? input.issue_number ?? input.state?.issue, 0);
  const pr = asInteger(input.pr ?? input.pr_number ?? input.state?.pr, 0);
  invariant(issue && pr, "review requires issue and pr", "INVALID_PUBLISH_INPUT");
  const review = normalizeAgentOutput(input.review ?? input, "review");
  const highRisk = review.findings.some((finding) => finding.risk === "high" && !finding.resolved);
  const mustFix = review.findings.some((finding) => finding.must_fix && !finding.resolved);
  const evaluation = isObject(input.evaluation) ? input.evaluation : isObject(input.decision) ? input.decision : {};
  const evaluationHumanRequired = evaluation.human_required === true || evaluation.next_phase === "human_required";
  const humanRequired = highRisk || evaluationHumanRequired;
  const priorState = await hydratedPublisherState(client, issue, input);
  const evaluationSplitRequired = evaluation.split_required === true || priorState.change_scope.split_required === true;
  const phase = humanRequired ? "human_required" : evaluationSplitRequired ? "split_required" : mustFix || review.verdict !== "pass" ? "plan" : "review";
  const reviewedProblems = review.findings.map((finding, index) =>
    normalizeProblem(
      {
        id: finding.id,
        problem: finding.problem,
        risk: finding.risk,
        status: finding.resolved ? "DONE" : highRisk && finding.risk === "high" ? "HUMAN_REQUIRED" : finding.must_fix ? "IN_PROGRESS" : "REVIEW_PENDING",
        evidence: finding.path ? `${finding.path}:${finding.line}` : "",
        owner: finding.human_owner,
        next_step: finding.suggested_fix,
      },
      index,
    ),
  );
  const mergedProblems = new Map(priorState.problems.map((problem) => [problem.id, problem]));
  for (const problem of reviewedProblems) mergedProblems.set(problem.id, problem);
  const canonicalProblems = [...mergedProblems.values()].map((problem) =>
    evaluationHumanRequired && ["OPEN", "PLANNED", "IN_PROGRESS", "REVIEW_PENDING"].includes(problem.status)
      ? { ...problem, status: "HUMAN_REQUIRED", next_step: problem.next_step || "Human review" }
      : problem,
  );
  let state = mergeState(priorState, {
    issue,
    pr,
    phase,
    reviewed_sha: review.reviewed_sha,
    all_ok: false,
    problems: canonicalProblems,
  });
  if (humanRequired) await addLabels(client, pr, ["agent:human-required"]);
  if (evaluationSplitRequired) await addLabels(client, pr, ["agent:split-required"]);
  const selectedReviewer = input.reviewer ?? priorState.reviewer;
  const reviewer = await requestReviewer(client, pr, selectedReviewer);
  const reviewerFailed = !reviewer.requested;
  const fallbackMention = input.fallback_mention ?? input.team?.fallback_mention ?? null;
  if (reviewerFailed) {
    await addLabels(client, pr, ["agent:human-required"]);
    state = mergeState(state, { phase: "human_required", reviewer: null, all_ok: false });
  } else state = mergeState(state, { reviewer: reviewer.requested });
  const humanMention = fallbackMention ?? (selectedReviewer ? `@${selectedReviewer}` : "maintainer");
  const humanPrefix = evaluationHumanRequired
    ? `결정론적 검증 결과 인간 확인이 필요합니다. ${humanMention}의 판단 후 재개하세요.`
    : input.summary ?? "";
  const canonical = await upsertStateComment(
    client,
    issue,
    state,
    reviewerFailed ? `Reviewer 요청에 실패했습니다. ${fallbackMention ?? "maintainer"}의 확인이 필요합니다.` : humanPrefix,
  );
  const inline = [];
  for (const finding of review.findings) {
    if (!finding.path || !finding.line || !review.reviewed_sha) continue;
    const body = [
      `**${finding.id}** · ${finding.risk} risk${finding.must_fix ? " · must fix" : ""}`,
      "",
      finding.problem,
      finding.suggested_fix ? `\nSuggested fix: ${finding.suggested_fix}` : "",
      canonical.comment_url ? `\n[Canonical progress](${canonical.comment_url})` : "",
    ].filter(Boolean).join("\n");
    const response = await client.request("POST", client.repoPath(`/pulls/${pr}/comments`), {
      body: { body, commit_id: review.reviewed_sha, path: finding.path, line: finding.line, side: "RIGHT" },
      allow_statuses: [422],
    });
    inline.push({ id: finding.id, posted: response.status !== 422, status: response.status });
  }
  const summaryBody = [
    `### Agent review — Iteration ${state.iteration}`,
    "",
    `Verdict: \`${review.verdict}\``,
    reviewerFailed ? `\n⚠️ Reviewer 요청 실패 — ${fallbackMention ?? "maintainer"} 확인 필요` : "",
    "",
    renderProgress(state),
    "",
    canonical.comment_url ? `[Canonical progress](${canonical.comment_url})` : "",
  ].filter(Boolean).join("\n");
  const summary = await postComment(client, pr, summaryBody);
  return {
    operation: "review",
    issue,
    pr,
    phase: state.phase,
    high_risk: highRisk,
    must_fix: mustFix,
    human_required: humanRequired || reviewerFailed,
    split_required: evaluationSplitRequired,
    inline,
    summary,
    reviewer,
    comment: canonical,
  };
}

async function publishReady(client, input) {
  const issue = asInteger(input.issue ?? input.issue_number ?? input.state?.issue, 0);
  const pr = asInteger(input.pr ?? input.pr_number ?? input.state?.pr, 0);
  invariant(issue && pr, "ready requires issue and pr", "INVALID_PUBLISH_INPUT");
  // publishReady commonly runs immediately after publishReview. Always prefer
  // that freshly persisted canonical state over the pre-review artifact passed
  // to this operation so new observations cannot be erased.
  const canonical = await findStateComment(client, issue);
  const latestState = canonical?.state ?? publisherState(input);
  // Lifecycle/base invariants fail closed here; head freshness is evaluated
  // below so a stale review can be recorded without mutating the PR.
  const live = await validateLivePublication(client, { ...input, state: latestState, pr, expected_head_sha: "", expected_base_sha: "" });
  const pull = live.pull;
  invariant(pull, "Canonical PR no longer exists", "UNSAFE_PR_LIFECYCLE");
  const currentSha = String(pull.head?.sha ?? "");
  const evaluation = input.review
    ? evaluateAllOk(input.review, latestState, { current_sha: currentSha })
    : input.evaluation;
  if (latestState.phase === "human_required" || input.evaluation?.all_ok !== true || evaluation?.all_ok !== true) {
    const staleState = mergeState(latestState, { issue, pr, current_sha: currentSha || input.current_sha, all_ok: false, phase: latestState.phase === "human_required" ? "human_required" : "review" });
    const comment = await upsertStateComment(
      client,
      issue,
      staleState,
      evaluation?.checks?.reviewed_current_head === false
        ? "검토 이후 PR head가 변경되어 기존 All OK를 무효화했습니다. 새 SHA를 다시 검토해야 합니다."
        : "All OK 조건이 더 이상 충족되지 않아 Draft를 유지합니다.",
    );
    return { operation: "ready", issue, pr, draft: true, merged: false, stale: true, evaluation, comment };
  }
  if (pull.draft !== false) {
    invariant(pull.node_id, "GitHub did not return the PR node id", "GITHUB_API_ERROR");
    const ready = await client.request("POST", client.graphqlUrl, {
      body: {
        query: "mutation MarkReady($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { number isDraft } } }",
        variables: { id: pull.node_id },
      },
    });
    invariant(!ready.data?.errors?.length, `GitHub GraphQL ready transition failed: ${ready.data?.errors?.[0]?.message ?? "unknown error"}`, "GITHUB_API_ERROR");
  }
  await addLabels(client, issue, ["agent:done"]);
  const state = mergeState(latestState, { issue, pr, current_sha: currentSha, reviewed_sha: currentSha, phase: "ready_for_human", all_ok: true });
  const comment = await upsertStateComment(client, issue, state, input.summary ?? "All OK — Draft를 해제했으며 인간 reviewer의 최종 판단을 기다립니다.");
  const prComment = await postComment(
    client,
    pr,
    [input.pr_summary ?? "All OK. 자동 merge는 수행하지 않습니다.", renderProgress(state), comment.comment_url ? `[Canonical progress](${comment.comment_url})` : null]
      .filter((value) => value !== null && value !== undefined && value !== "")
      .join("\n\n"),
  );
  return { operation: "ready", issue, pr, draft: false, merged: false, comment, pr_comment: prComment };
}

export async function publish(client, operation, input) {
  if (operation === "approval-required") return publishApprovalRequired(client, input);
  if (operation === "protected-approval-required") return publishProtectedApprovalRequired(client, input);
  if (operation === "analysis") return publishAnalysis(client, input);
  if (operation === "pr") return publishPr(client, input);
  if (operation === "review") return publishReview(client, input);
  if (operation === "ready") return publishReady(client, input);
  if (operation === "state") {
    const issue = asInteger(input.issue ?? input.issue_number ?? input.state?.issue, 0);
    invariant(issue, "state requires issue", "INVALID_PUBLISH_INPUT");
    const state = await hydratedPublisherState(client, issue, input, { issue });
    const pr = asInteger(input.pr ?? input.pr_number ?? state.pr, 0) || null;
    if (state.phase === "human_required") {
      await addLabels(client, issue, ["agent:human-required"]);
      if (pr) await addLabels(client, pr, ["agent:human-required"]);
    }
    if (state.change_scope.split_required) {
      await addLabels(client, issue, ["agent:split-required"]);
      if (pr) await addLabels(client, pr, ["agent:split-required"]);
    }
    const comment = await upsertStateComment(client, issue, state, input.body ?? "");
    const prComment = pr
      ? await postComment(
          client,
          pr,
          [input.body, renderProgress(state), comment.comment_url ? `[Canonical progress](${comment.comment_url})` : null]
            .filter(Boolean)
            .join("\n\n"),
        )
      : null;
    return { operation: "state", issue, pr, comment, pr_comment: prComment };
  }
  throw new PipelineError(`Unsupported publish operation: ${operation}`, "INVALID_ARGUMENT");
}

/** Reconciles model-authored plan metadata with trusted state and team policy. */
/**
 * Validates a model-proposed multi-unit split against the reconciled whole-
 * issue plan. A split is accepted only when every problem and every changed
 * path is claimed by exactly one unit; any conflict is rejected and the
 * caller falls back to the single reviewable PR that has always been safe.
 */
function splitPlanIntoUnits(team, issueNumber, plan) {
  const proposed = asArray(plan.units);
  if (proposed.length === 0) return { units: [], reason: "no_units_proposed" };
  if (proposed.length === 1) return { units: [], reason: "single_unit_proposed" };
  const ids = proposed.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) return { units: [], reason: "duplicate_unit_id" };
  const problemIds = new Set(plan.problems.map((problem) => problem.id));
  const problemOwner = new Map();
  for (const entry of proposed) {
    for (const problemId of entry.problem_ids) {
      if (!problemIds.has(problemId)) return { units: [], reason: "unit_references_unknown_problem" };
      if (problemOwner.has(problemId)) return { units: [], reason: "problem_assigned_to_multiple_units" };
      problemOwner.set(problemId, entry.id);
    }
  }
  if (problemOwner.size !== plan.problems.length) return { units: [], reason: "problem_not_assigned_to_any_unit" };
  const pathOwner = new Map();
  for (const entry of proposed) {
    for (const filePath of entry.changed_paths) {
      if (pathOwner.has(filePath)) return { units: [], reason: "changed_path_claimed_by_multiple_units" };
      pathOwner.set(filePath, entry.id);
    }
  }
  const units = proposed.map((entry) => ({
    id: entry.id,
    title: entry.title,
    issue: plan.issue,
    iteration: plan.iteration,
    phase: "plan",
    risk: plan.risk,
    problems: plan.problems.filter((problem) => problemOwner.get(problem.id) === entry.id),
    steps: entry.steps,
    validation_commands: plan.validation_commands,
    changed_paths: entry.changed_paths,
    branch: branchName(team, issueNumber, entry.title, entry.id),
  }));
  return { units, reason: "valid" };
}

export function reconcilePlan(team, planInput, stateInput) {
  const plan = normalizeAgentOutput(planInput, "plan");
  const state = initialState(stateInput);
  invariant(Number.isInteger(state.issue) && state.issue > 0, "Canonical state is missing a source Issue", "INVALID_STATE");
  const trustedCommands = asArray(team.pipeline?.validation_commands).map(String);
  invariant(trustedCommands.length > 0 && trustedCommands.every(Boolean), "team.yaml must define validation commands", "INVALID_TEAM_POLICY");
  const maxIterations = Math.max(1, asInteger(team.pipeline?.max_auto_iterations, 5));
  const expectedIteration = state.iteration + 1;
  const maxReached = expectedIteration > maxIterations;
  const corrections = [];
  if (plan.issue !== state.issue) corrections.push("issue");
  if (plan.iteration !== expectedIteration) corrections.push("iteration");
  if (JSON.stringify(plan.validation_commands) !== JSON.stringify(trustedCommands)) corrections.push("validation_commands");

  const priorById = new Map(state.problems.map((problem) => [problem.id, problem]));
  const seen = new Set();
  const problems = plan.problems.map((problem) => {
    invariant(!seen.has(problem.id), `Duplicate plan Problem ID: ${problem.id}`, "INVALID_AGENT_OUTPUT");
    seen.add(problem.id);
    const prior = priorById.get(problem.id);
    const lockedHuman = prior?.status === "HUMAN_REQUIRED";
    return normalizeProblem({
      ...problem,
      risk: prior?.risk === "high" ? "high" : problem.risk,
      status: lockedHuman ? "HUMAN_REQUIRED" : problem.status,
      owner: problem.owner ?? prior?.owner ?? null,
      evidence: problem.evidence || prior?.evidence,
      next_step: lockedHuman ? prior.next_step : problem.next_step,
    });
  });
  for (const prior of state.problems) if (!seen.has(prior.id)) problems.push(prior);

  if (maxReached) {
    for (let index = 0; index < problems.length; index += 1) {
      if (!["DONE", "FIXED"].includes(problems[index].status)) {
        problems[index] = { ...problems[index], status: "HUMAN_REQUIRED", next_step: "Maintainer decision after iteration limit" };
      }
    }
    if (!problems.some((problem) => problem.id === "P-700000000")) {
      problems.push({
        id: "P-700000000",
        problem: "Maximum automatic iteration count reached",
        risk: "low",
        status: "HUMAN_REQUIRED",
        evidence: `team.yaml max_auto_iterations=${maxIterations}`,
        owner: state.assignee,
        next_step: "Maintainer decision",
      });
    }
  }

  const canonicalPlan = {
    ...plan,
    issue: state.issue,
    iteration: maxReached ? state.iteration : expectedIteration,
    risk: maxReached ? "high" : plan.risk,
    problems,
    validation_commands: trustedCommands,
  };
  const split = maxReached ? { units: [], reason: "max_iterations_reached" } : splitPlanIntoUnits(team, state.issue, canonicalPlan);
  return {
    plan: canonicalPlan,
    units: split.units,
    split: split.units.length > 1,
    split_reason: split.reason,
    human_required: maxReached,
    max_iterations_reached: maxReached,
    max_auto_iterations: maxIterations,
    expected_iteration: expectedIteration,
    corrections,
  };
}

export function planFromReview(team, reviewInput, stateInput) {
  const review = normalizeAgentOutput(reviewInput, "review");
  const state = initialState(stateInput);
  const nextIteration = state.iteration + 1;
  const maxIterations = Math.max(1, asInteger(team.pipeline?.max_auto_iterations, 5));
  const failedCommands = [
    ...new Map(
      state.validation.commands
        .filter((command) => command.passed !== true || command.exit_code !== 0)
        .map((command) => [command.command || "unknown validation command", command]),
    ).values(),
  ];
  const validationFailures = failedCommands
    .map((command) => {
      const name = command.command || "unknown validation command";
      const digest = BigInt(`0x${createHash("sha256").update(name).digest("hex")}`).toString();
      return {
        id: `P-9${digest}`,
        path: "validation",
        line: 1,
        problem: `Validation failed: ${name}`,
        risk: "low",
        must_fix: true,
        suggested_fix: `Fix the failure from \`${name}\` and rerun validation`,
        human_owner: null,
      };
    });
  if (state.validation.passed !== true && validationFailures.length === 0) {
    validationFailures.push({
      id: "P-8000000000000000",
      path: "validation",
      line: 1,
      problem: "Validation did not pass and no command-level result was recorded",
      risk: "low",
      must_fix: true,
      suggested_fix: "Reproduce the configured validation failure, fix it, and rerun every configured command",
      human_owner: null,
    });
  }
  const unresolved = [...review.findings.filter((finding) => !finding.resolved && finding.must_fix), ...validationFailures];
  const priorHighRisk = lower(state.plan?.risk) === "high";
  const highRisk = priorHighRisk || unresolved.some((finding) => finding.risk === "high");
  const exhausted = nextIteration > maxIterations;
  const phase = highRisk || exhausted ? "human_required" : unresolved.length ? "plan" : "review";
  return {
    issue: state.issue,
    iteration: nextIteration,
    phase,
    risk: highRisk ? "high" : "low",
    human_required: highRisk || exhausted,
    max_iterations_reached: exhausted,
    reviewed_sha: review.reviewed_sha,
    risk_context: deepClone(
      state.plan?.risk_context ?? {
        domains: [],
        intake_security: "unknown",
        categories: [],
        assessment: normalizeRiskAssessment({}),
        reasons: [],
      },
    ),
    problems: unresolved.map((finding, index) =>
      normalizeProblem(
        {
          id: finding.id,
          problem: finding.problem,
          risk: finding.risk,
          status: finding.resolved ? "DONE" : finding.risk === "high" || exhausted ? "HUMAN_REQUIRED" : finding.must_fix ? "PLANNED" : "REVIEW_PENDING",
          evidence: finding.path === "validation" ? finding.problem : finding.path ? `${finding.path}:${finding.line}` : "",
          owner: finding.human_owner,
          next_step: finding.suggested_fix,
        },
        index,
      ),
    ),
    steps: highRisk || exhausted ? [] : unresolved.map((finding) => finding.suggested_fix || `Resolve ${finding.id}: ${finding.problem}`),
    validation_commands: asArray(team.pipeline?.validation_commands).map(String),
    changed_paths: unique(unresolved.map((finding) => finding.path).filter((filePath) => filePath && filePath !== "validation")),
  };
}

function branchSlug(value) {
  const normalized = String(value ?? "issue")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return (normalized || "work").slice(0, 48).replace(/-+$/g, "") || "work";
}

export function branchName(team, issueNumber, title, unit = null) {
  const issue = asInteger(issueNumber, 0);
  invariant(issue > 0, "A positive issue number is required", "INVALID_ARGUMENT");
  const unitSegment = unit ? `${branchSlug(unit)}-` : "";
  return `${team.pipeline?.branch_prefix ?? "agent/issue-"}${issue}-${unitSegment}${branchSlug(title)}`;
}

function writeGithubOutputs(result, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  const entries = isObject(result) ? Object.entries(result) : [["result", result]];
  const complete = JSON.stringify(result);
  const outputs = complete.length <= 8192 ? [...entries, ["result_json", result]] : entries;
  for (const [rawKey, value] of outputs) {
    const key = String(rawKey).replace(/[^a-zA-Z0-9_]/g, "_");
    const serialized = isObject(value) || Array.isArray(value) ? JSON.stringify(value) : value === null || value === undefined ? "" : String(value);
    if (serialized.length > 8192) continue;
    if (serialized.includes("\n")) {
      const delimiter = `PIPELINE_${key}_${Buffer.from(serialized).toString("base64url").slice(0, 16)}`;
      appendFileSync(outputPath, `${key}<<${delimiter}\n${serialized}\n${delimiter}\n`);
    } else appendFileSync(outputPath, `${key}=${serialized}\n`);
  }
}

function writeDataFile(outputPath, value, raw = false) {
  if (!outputPath) return;
  const absolute = resolve(String(outputPath));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, raw ? String(value) : `${stableStringify(value)}\n`);
}

function emit(value, args, options = {}) {
  if (args.output && !options.outputAlreadyWritten) writeDataFile(args.output, value, options.raw);
  writeGithubOutputs(options.githubValue ?? value, args.github_output === false ? null : args.github_output);
  if (!options.quiet) process.stdout.write(options.raw ? `${String(value)}${String(value).endsWith("\n") ? "" : "\n"}` : `${stableStringify(value)}\n`);
}

function requiredArg(args, name) {
  invariant(args[name] !== undefined && args[name] !== true && args[name] !== "", `--${name.replaceAll("_", "-")} is required`, "INVALID_ARGUMENT");
  return args[name];
}

function inputFromArgs(args, names = ["input"]) {
  const name = names.find((candidate) => args[candidate] !== undefined);
  return name ? readJsonish(args[name], `--${name.replaceAll("_", "-")}`) : {};
}

function rawInput(path, label) {
  invariant(path && path !== true, `${label} is required`, "INVALID_ARGUMENT");
  return path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
}

async function enrichGateEvent(eventInput, eventName, args) {
  const event = deepClone(eventInput);
  const name = String(eventName ?? "");
  const tokenAvailable = Boolean(process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN);
  if (!tokenAvailable) return event;
  const client = new GitHubClient();
  let prNumber = asInteger(args.dispatch_pr ?? event.inputs?.pr_number, 0) || null;
  let issueNumber = asInteger(args.dispatch_issue ?? event.inputs?.issue_number, 0) || null;
  if (name === "issue_comment") {
    if (event.issue?.pull_request) prNumber = event.issue.number;
    else issueNumber = event.issue?.number ?? issueNumber;
  }
  if (name === "workflow_dispatch" && !prNumber && !issueNumber) return event;

  // Resuming a source Issue should pick up the existing PR from its canonical
  // state, rather than starting another branch.
  if (!prNumber && issueNumber) {
    const found = await findStateComment(client, issueNumber);
    prNumber = found?.state?.pr ?? null;
  }
  if (prNumber && !event.pull_request) {
    const response = await client.request("GET", client.repoPath(`/pulls/${prNumber}`));
    event.pull_request = response.data;
  }
  if (issueNumber && !event.issue && name === "workflow_dispatch") {
    const response = await client.request("GET", client.repoPath(`/issues/${issueNumber}`));
    event.issue = response.data;
  }
  return event;
}

function helpText() {
  return `Deterministic issue-review pipeline controller

Usage: node pipeline.mjs <command> [options]

Read-only policy/data commands (JSON stdout; all accept --output FILE):
  validate-team       --team FILE
  validation-commands --team FILE
  gate-event          --event FILE [--event-name NAME] [--team FILE]
                      [--enriched-output FILE]
  route-agent         --team FILE [--assignee LOGIN | --triage FILE]
  select-owner        --team FILE (--event FILE | --input FILE)
  select-pr-team      --team FILE --input FILE [--changed-files FILE]
  build-codegraph     --team FILE [--repo DIR] [--event FILE] [--blame-files FILE]
  normalize-agent-output --kind triage|plan|review --input FILE [--agent NAME]
  reconcile-plan      --team FILE --plan FILE --state FILE
  evaluate-risk       --team FILE --input FILE [--paths FILE]
  evaluate-change-scope --team FILE --patch FILE
  check-protected     --team FILE --paths FILE [--approved]
  authorize-protected --team FILE --issue FILE --comments FILE [--paths FILE]
                      [--state FILE | --implementer LOGIN] --evidence-fresh
  evaluate-review     --review FILE --state FILE [--team FILE] [--current-sha SHA]
  plan-from-review    --review FILE --state FILE --team FILE [--validation FILE]
  render-progress     --state FILE (Markdown stdout)
  merge-state         --state FILE --input UPDATE.json
  branch-name         --team FILE --issue NUMBER --title TEXT
  paths-from-nul      --input FILE --output FILE
  changed-files       --patch FILE
  create-patch        [--repo DIR] [--base REF] --output PATCH.diff
  check-live-publication --input FILE

Cross-run state and writes:
  load-state --event FILE [--issue N] [--pr N] --output state.json
  publish --operation approval-required|protected-approval-required|analysis|pr|review|ready|state
          --input FILE [--repo DIR]

GitHub commands use GH_TOKEN, GITHUB_REPOSITORY, and GITHUB_API_URL. All scalar
object properties are also appended to GITHUB_OUTPUT when that env var is set.
The pr publisher requires state.validation.passed and state.protected_paths.passed,
creates/reuses a draft PR, checks assignability, and never force-pushes or merges.
`;
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || ["help", "--help", "-h"].includes(command)) {
    process.stdout.write(helpText());
    return;
  }
  const teamPath = args.team ?? ".github/agent-pipeline/team.yaml";

  if (command === "validate-team") {
    const team = loadTeam(teamPath);
    return emit({ valid: true, version: team.version, people: team.people.length }, args);
  }
  if (command === "validation-commands") {
    const team = loadTeam(teamPath);
    return emit(asArray(team.pipeline?.validation_commands).map(String), args, {
      githubValue: { commands_json: asArray(team.pipeline?.validation_commands).map(String) },
    });
  }
  if (command === "gate-event" || command === "gate") {
    const team = loadTeam(teamPath);
    const eventName = args.event_name ?? process.env.GITHUB_EVENT_NAME;
    const rawEvent = readJsonish(args.event ?? process.env.GITHUB_EVENT_PATH, "event");
    const event = await enrichGateEvent(rawEvent, eventName, args);
    if (args.enriched_output) writeDataFile(args.enriched_output, event);
    const state = args.state ? readJsonish(args.state, "state") : {};
    return emit(
      gateEvent(event, eventName, team, {
        ...state,
        ...args,
        dispatch_issue: args.dispatch_issue ?? rawEvent.inputs?.issue_number,
        dispatch_pr: args.dispatch_pr ?? rawEvent.inputs?.pr_number,
        dispatch_phase: args.dispatch_phase ?? rawEvent.inputs?.phase,
      }),
      args,
    );
  }
  if (command === "route-agent") {
    const team = loadTeam(teamPath);
    const triage = args.triage ? readJsonish(args.triage, "triage") : {};
    const state = args.state ? readJsonish(args.state, "state") : {};
    return emit(routeAgent(team, args.assignee ?? triage.assignee ?? state.assignee ?? state.plan?.assignee), args);
  }
  if (command === "select-owner") {
    const team = loadTeam(teamPath);
    const issue = inputFromArgs(args, ["event", "input", "issue"]);
    return emit(selectOwner(team, issue), args);
  }
  if (command === "select-pr-team") {
    const team = loadTeam(teamPath);
    const input = inputFromArgs(args);
    const state = args.state ? readJsonish(args.state, "state") : {};
    if (args.changed_files) input.changed_files = readPaths(args.changed_files);
    input.issue_assignee ??= state.assignee ?? state.plan?.assignee;
    input.implementer ??= state.assignee ?? state.plan?.assignee;
    input.domains ??= state.plan?.domains ?? [];
    input.risk ??= state.plan?.risk;
    for (const name of ["issue_assignee", "author", "implementer", "risk"]) if (args[name] !== undefined) input[name] = args[name];
    return emit(selectPrTeam(team, input), args);
  }
  if (command === "normalize-agent-output" || command === "normalize") {
    const value = rawInput(requiredArg(args, "input"), "--input");
    return emit(normalizeAgentOutput(value, requiredArg(args, "kind"), { agent: args.agent }), args);
  }
  if (command === "reconcile-plan") {
    const team = loadTeam(teamPath);
    return emit(
      reconcilePlan(team, readJsonish(requiredArg(args, "plan"), "--plan"), readJsonish(requiredArg(args, "state"), "--state")),
      args,
    );
  }
  if (command === "evaluate-risk") {
    const team = loadTeam(teamPath);
    const input = inputFromArgs(args);
    if (args.paths) input.paths = readPaths(args.paths);
    return emit(evaluateRisk(team, input), args);
  }
  if (command === "evaluate-change-scope") {
    const team = loadTeam(teamPath);
    return emit(evaluateChangeScope(team, rawInput(requiredArg(args, "patch"), "--patch")), args);
  }
  if (command === "check-protected") {
    const team = loadTeam(teamPath);
    return emit(checkProtectedPaths(team, readPaths(requiredArg(args, "paths")), args.approved), args);
  }
  if (command === "authorize-protected") {
    const team = loadTeam(teamPath);
    const input = {
      issue: readJsonish(requiredArg(args, "issue"), "--issue"),
      comments: readJsonish(requiredArg(args, "comments"), "--comments"),
      state: args.state ? readJsonish(args.state, "--state") : {},
      implementer: args.implementer,
      evidence_fresh: args.evidence_fresh,
    };
    if (args.paths !== undefined) input.paths = readPaths(args.paths);
    return emit(authorizeProtectedPaths(team, input), args);
  }
  if (["all-ok", "evaluate-all-ok", "evaluate-review"].includes(command)) {
    const review = readJsonish(requiredArg(args, "review"), "review");
    let state = readJsonish(requiredArg(args, "state"), "state");
    if (args.validation) state = mergeState(state, { validation: readJsonish(args.validation, "validation") });
    if (args.protected) state = mergeState(state, { protected_paths: readJsonish(args.protected, "protected") });
    if (args.change_scope) state = mergeState(state, { change_scope: readJsonish(args.change_scope, "change scope") });
    const team = existsSync(teamPath) ? loadTeam(teamPath) : null;
    return emit(
      evaluateAllOk(review, state, {
        current_sha: args.current_sha,
        max_auto_iterations: team?.pipeline?.max_auto_iterations,
      }),
      args,
    );
  }
  if (command === "plan-from-review") {
    const team = loadTeam(teamPath);
    let state = readJsonish(requiredArg(args, "state"), "state");
    if (args.validation) state = mergeState(state, { validation: readJsonish(args.validation, "validation") });
    return emit(planFromReview(team, readJsonish(requiredArg(args, "review"), "review"), state), args);
  }
  if (command === "render-progress") {
    const markdown = renderProgress(readJsonish(requiredArg(args, "state"), "state"));
    return emit(markdown, args, { raw: true, githubValue: { progress: markdown } });
  }
  if (command === "merge-state" || command === "update-state") {
    const state = readJsonish(requiredArg(args, "state"), "state");
    const update = inputFromArgs(args);
    return emit(mergeState(state, update), args);
  }
  if (command === "branch-name") {
    const team = loadTeam(teamPath);
    const branch = branchName(team, requiredArg(args, "issue"), requiredArg(args, "title"));
    return emit({ branch }, args);
  }
  if (command === "paths-from-nul") {
    const paths = pathsFromNul(rawInput(requiredArg(args, "input"), "--input"));
    return emit(paths, args, { githubValue: { changed_files_json: paths } });
  }
  if (command === "changed-files") {
    const paths = changedFilesFromPatch(rawInput(requiredArg(args, "patch"), "--patch"));
    return emit(paths, args, { githubValue: { changed_files_json: paths } });
  }
  if (command === "create-patch") {
    const result = createPatch({ repo: args.repo, base: args.base });
    if (args.output) writeDataFile(args.output, result.patch, true);
    return emit({ changed_paths: result.changed_paths, untracked: result.untracked, base: result.base, output: args.output ?? null }, args, {
      outputAlreadyWritten: Boolean(args.output),
    });
  }
  if (command === "build-codegraph") {
    const team = loadTeam(teamPath);
    const issue = args.event ? readJsonish(args.event, "event") : args.issue_file ? readJsonish(args.issue_file, "issue") : null;
    const graph = buildCodegraph(team, { repo: args.repo, issue, blame_files: args.blame_files, max_files: args.max_files });
    return emit(graph, args);
  }
  if (["load-state", "recover-state", "fetch-state"].includes(command)) {
    const client = new GitHubClient();
    const event = args.event ? readJsonish(args.event, "event") : process.env.GITHUB_EVENT_PATH ? readJsonish(process.env.GITHUB_EVENT_PATH, "event") : {};
    const state = await loadState(client, { event, issue: args.issue, pr: args.pr, source_issue_number: args.source_issue_number });
    return emit(state, args);
  }
  if (command === "check-live-publication") {
    const client = new GitHubClient();
    const result = await validateLivePublication(client, inputFromArgs(args));
    return emit({ ...result, pull: result.pull ? { number: result.pull.number, state: result.pull.state, draft: result.pull.draft } : null }, args);
  }
  if (command === "publish") {
    const client = new GitHubClient();
    const input = inputFromArgs(args);
    if (args.repo !== undefined) input.repo = args.repo;
    const result = await publish(client, requiredArg(args, "operation"), input);
    return emit(result, args);
  }
  throw new PipelineError(`Unknown command: ${command}. Run 'pipeline.mjs help'.`, "UNKNOWN_COMMAND");
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runCli().catch((error) => {
    const result = {
      error: error?.message ?? String(error),
      code: error?.code ?? "UNEXPECTED_ERROR",
      ...(error?.details === undefined ? {} : { details: error.details }),
    };
    process.stderr.write(`${stableStringify(result)}\n`);
    process.exitCode = 1;
  });
}
