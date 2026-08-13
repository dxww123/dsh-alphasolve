import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, link, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import path, { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { assembleContextFor, installModelSelection } from "@deepseek-ai/dsh-agent";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { SessionId } from "@deepseek-ai/dsh-session";
//#region src/atomic.ts
/** Small persistence helpers built on DSH's reviewed atomic replacement primitive. */
/** Error thrown when durable JSON is malformed or has an unexpected root shape. */
var DurableDataError = class extends Error {
	path;
	constructor(message, path, options) {
		super(`${message}: ${path}`, options);
		this.path = path;
		this.name = "DurableDataError";
	}
};
/** Atomically replace a user-private UTF-8 text file. */
async function atomicWriteText(path, content) {
	await writeFileAtomic(path, content, {
		mode: 384,
		dirMode: 448
	});
}
/** Atomically replace a user-private JSON file with stable human-readable output. */
async function atomicWriteJson(path, value) {
	await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}
/** Read JSON and fail with a path-bearing diagnostic. */
async function readJson(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new DurableDataError("unable to read durable JSON", path, { cause: error });
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new DurableDataError("malformed durable JSON", path, { cause: error });
	}
}
/** Read an object-rooted JSON document. */
async function readJsonObject(path) {
	const value = await readJson(path);
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DurableDataError("durable JSON root must be an object", path);
	return value;
}
//#endregion
//#region src/types.ts
/** Shared durable and model-facing types for AlphaSolve for DSH. */
/** Current on-disk state format. Unknown newer versions are rejected. */
const STATE_VERSION = 1;
/** Roles that may receive an explicit model-route override. */
const MODEL_ROLES = [
	"generator",
	"verifier",
	"reviser",
	"theorem_checker",
	"curator",
	"compute",
	"numerical_experiment",
	"research_reviewer",
	"reasoning"
];
/** Stable verifier order from AlphaSolve main. */
const VERIFIER_PROFILES = [
	"format_references",
	"citation",
	"failure_modes",
	"stepwise",
	"premise_chain"
];
const ROOT_FIELDS = /* @__PURE__ */ new Set([
	"capacity",
	"detailedTrace",
	"models"
]);
const MODEL_FIELDS = /* @__PURE__ */ new Set([
	"provider",
	"model",
	"reasoningEffort"
]);
const MODEL_ROLE_SET = new Set(MODEL_ROLES);
function isRecord$3(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail$1(source, field, reason) {
	throw new TypeError(`${source}: field "${field}" ${reason}`);
}
function assertKnownFields(source, owner, value, known) {
	const unknown = Object.keys(value).filter((key) => !known.has(key));
	if (unknown.length > 0) throw new TypeError(`${source}: ${owner} contains unknown field${unknown.length === 1 ? "" : "s"} ${unknown.map((key) => `"${key}"`).join(", ")}`);
}
function assertPositiveCapacity(value, source = "configuration") {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return fail$1(source, "capacity", "must be a positive safe integer");
	return value;
}
function parseNonEmptyString(value, source, field) {
	if (typeof value !== "string" || value.trim().length === 0) return fail$1(source, field, "must be a non-empty string");
	if (value !== value.trim()) return fail$1(source, field, "must not have leading or trailing whitespace");
	return value;
}
function parseModelOverride(value, source, role) {
	const field = `models.${role}`;
	if (!isRecord$3(value)) return fail$1(source, field, "must be an object");
	assertKnownFields(source, field, value, MODEL_FIELDS);
	const provider = value.provider === void 0 ? void 0 : parseNonEmptyString(value.provider, source, `${field}.provider`);
	const model = value.model === void 0 ? void 0 : parseNonEmptyString(value.model, source, `${field}.model`);
	const reasoningEffort = value.reasoningEffort === void 0 ? void 0 : parseNonEmptyString(value.reasoningEffort, source, `${field}.reasoningEffort`);
	return Object.freeze({
		...provider === void 0 ? {} : { provider },
		...model === void 0 ? {} : { model },
		...reasoningEffort === void 0 ? {} : { reasoningEffort }
	});
}
/** Strictly validate a parsed user- or project-level configuration object. */
function parseModelConfig(value, source = "configuration") {
	if (!isRecord$3(value)) throw new TypeError(`${source}: configuration root must be an object`);
	assertKnownFields(source, "configuration root", value, ROOT_FIELDS);
	const capacity = value.capacity === void 0 ? void 0 : assertPositiveCapacity(value.capacity, source);
	const detailedTrace = value.detailedTrace;
	if (detailedTrace !== void 0 && typeof detailedTrace !== "boolean") return fail$1(source, "detailedTrace", "must be a boolean");
	let models;
	if (value.models !== void 0) {
		if (!isRecord$3(value.models)) return fail$1(source, "models", "must be an object");
		const unknownRoles = Object.keys(value.models).filter((role) => !MODEL_ROLE_SET.has(role));
		if (unknownRoles.length > 0) throw new TypeError(`${source}: models contains unknown role${unknownRoles.length === 1 ? "" : "s"} ${unknownRoles.map((role) => `"${role}"`).join(", ")}`);
		models = {};
		for (const role of MODEL_ROLES) if (value.models[role] !== void 0) models[role] = parseModelOverride(value.models[role], source, role);
		Object.freeze(models);
	}
	return Object.freeze({
		...capacity === void 0 ? {} : { capacity },
		...detailedTrace === void 0 ? {} : { detailedTrace },
		...models === void 0 ? {} : { models }
	});
}
/** Parse JSON without losing the path-specific diagnostic required by activation. */
function parseModelConfigJson(text, source) {
	let value;
	try {
		value = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new TypeError(`${source}: invalid JSON: ${message}`);
	}
	return parseModelConfig(value, source);
}
function mergeOverrides(lower, higher) {
	if (lower === void 0 && higher === void 0) return void 0;
	const merged = {};
	for (const role of MODEL_ROLES) {
		const low = lower?.[role];
		const high = higher?.[role];
		if (low === void 0 && high === void 0) continue;
		merged[role] = Object.freeze({
			...low,
			...high
		});
	}
	return Object.freeze(merged);
}
/** Merge configurations from lowest to highest precedence, field by field. */
function mergeModelConfigs(...configs) {
	let capacity;
	let detailedTrace;
	let models;
	for (const config of configs) {
		if (config.capacity !== void 0) capacity = assertPositiveCapacity(config.capacity);
		if (config.detailedTrace !== void 0) detailedTrace = config.detailedTrace;
		models = mergeOverrides(models, config.models);
	}
	return Object.freeze({
		...capacity === void 0 ? {} : { capacity },
		...detailedTrace === void 0 ? {} : { detailedTrace },
		...models === void 0 ? {} : { models }
	});
}
/** Apply the product precedence: prompt > project > user > built-in default. */
function resolveAlphaSolveConfig(options = {}) {
	const merged = mergeModelConfigs(options.user ?? {}, options.project ?? {});
	const capacity = options.promptCapacity !== void 0 ? assertPositiveCapacity(options.promptCapacity, "prompt") : merged.capacity ?? assertPositiveCapacity(options.defaultCapacity ?? 2, "default configuration");
	const detailedTrace = merged.detailedTrace ?? options.defaultDetailedTrace ?? true;
	return Object.freeze({
		capacity,
		detailedTrace,
		models: merged.models ?? Object.freeze({})
	});
}
/**
* Resolve a complete immutable model selection for a newly-created role Agent.
* Existing Agents retain the previously resolved object when configuration changes.
*/
function resolveRoleModelSelection(role, inherited, overrides = {}, isAvailable) {
	const override = overrides[role];
	const provider = override?.provider ?? inherited.provider;
	const model = override?.model ?? inherited.model;
	const effort = override?.reasoningEffort ?? inherited.reasoningEffort;
	parseNonEmptyString(provider, "resolved model selection", `${role}.provider`);
	parseNonEmptyString(model, "resolved model selection", `${role}.model`);
	if (isAvailable !== void 0 && !isAvailable(provider, model)) throw new Error(`model selection for role "${role}" is not registered: ${provider}/${model}`);
	return Object.freeze({
		provider,
		model,
		...effort === void 0 ? {} : { reasoningEffort: effort }
	});
}
//#endregion
//#region src/workspace.ts
/** Canonical workspace validation and AlphaSolve-owned directory initialization. */
/** Error whose message is safe to return in an activation/tool diagnostic. */
var WorkspaceError = class extends Error {
	path;
	constructor(message, path, options) {
		super(path === void 0 ? message : `${message}: ${path}`, options);
		this.path = path;
		this.name = "WorkspaceError";
	}
};
/** AlphaSolve-owned paths relative to the immutable workspace root. */
const WORKSPACE_DIRS = [
	"knowledge",
	"knowledge/references",
	"unverified_propositions",
	"verified_propositions",
	".alphasolve",
	".alphasolve/workers",
	".alphasolve/completions",
	".alphasolve/curator",
	".alphasolve/traces",
	".alphasolve/backups",
	".alphasolve/tmp"
];
/** Return a SHA-256 digest for immutable-input and conflict checks. */
function digestText(content) {
	return createHash("sha256").update(content).digest("hex");
}
/** Whether a canonical candidate is the root itself or a descendant. */
function isContained(root, candidate) {
	const rel = relative(root, candidate);
	return rel === "" || !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
/** Normalize an untrusted relative path without accepting either platform's escape syntax. */
function normalizeRelativePath(input) {
	if (input.length === 0 || input.includes("\0")) throw new WorkspaceError("path must be a non-empty relative path", input);
	if (isAbsolute(input) || win32.isAbsolute(input) || input.startsWith("\\\\")) throw new WorkspaceError("absolute paths are not allowed", input);
	const components = input.replaceAll("\\", "/").split("/");
	if (components.some((component) => component === "" || component === "." || component === "..")) throw new WorkspaceError("path contains an empty, dot, or parent component", input);
	return components.join("/");
}
/** Canonicalize the session's immutable cwd and require an existing directory. */
async function canonicalWorkspace(cwd) {
	if (cwd === void 0 || cwd.trim() === "") throw new WorkspaceError("the session has no workspace cwd");
	let canonical;
	try {
		canonical = await realpath(cwd);
		if (!(await stat(canonical)).isDirectory()) throw new WorkspaceError("session cwd is not a directory", cwd);
	} catch (error) {
		if (error instanceof WorkspaceError) throw error;
		throw new WorkspaceError("unable to resolve session cwd", cwd, { cause: error });
	}
	return canonical;
}
/** Find the nearest existing ancestor without following a missing-path guess. */
async function nearestExisting(path) {
	let cursor = path;
	for (;;) {
		try {
			await lstat(cursor);
			return cursor;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		const parent = dirname(cursor);
		if (parent === cursor) throw new WorkspaceError("no existing ancestor for path", path);
		cursor = parent;
	}
}
/**
* Resolve a relative workspace path and reject lexical and symlink escapes.
* Missing final components are allowed only when `mustExist` is false.
*/
async function resolveWorkspacePath(root, input, options) {
	let canonicalRoot;
	try {
		canonicalRoot = await realpath(root);
		if (!(await stat(canonicalRoot)).isDirectory()) throw new WorkspaceError("workspace root is not a directory", root);
	} catch (error) {
		if (error instanceof WorkspaceError) throw error;
		throw new WorkspaceError("unable to resolve workspace root", root, { cause: error });
	}
	const normalized = normalizeRelativePath(input);
	const target = resolve(canonicalRoot, ...normalized.split("/"));
	if (!isContained(canonicalRoot, target)) throw new WorkspaceError("path escapes the workspace", input);
	try {
		const canonical = await realpath(target);
		if (!isContained(canonicalRoot, canonical)) throw new WorkspaceError("symlink resolves outside the workspace", input);
		return target;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		if (options.mustExist) throw new WorkspaceError("required path does not exist", input, { cause: error });
	}
	let ancestor;
	try {
		ancestor = await realpath(await nearestExisting(target));
	} catch (error) {
		if (error instanceof WorkspaceError) throw error;
		throw new WorkspaceError("unable to validate path ancestry", input, { cause: error });
	}
	if (!isContained(canonicalRoot, ancestor)) throw new WorkspaceError("path ancestry resolves outside the workspace", input);
	return target;
}
/** Decode bytes as strict UTF-8 instead of silently replacing invalid sequences. */
function decodeUtf8$2(bytes, path) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new WorkspaceError("file is not valid UTF-8", path, { cause: error });
	}
}
/** Read one safe ordinary UTF-8 file and compute its digest. */
async function readWorkspaceInput(root, relativePath, options) {
	const path = await resolveWorkspacePath(root, relativePath, { mustExist: true });
	let bytes;
	try {
		if (!(await stat(path)).isFile()) throw new WorkspaceError("input is not an ordinary file", relativePath);
		bytes = await readFile(path);
	} catch (error) {
		if (error instanceof WorkspaceError) throw error;
		throw new WorkspaceError("unable to read input file", relativePath, { cause: error });
	}
	const content = decodeUtf8$2(bytes, relativePath);
	if (options.nonEmpty && content.trim() === "") throw new WorkspaceError("input file is empty", relativePath);
	return {
		path,
		content,
		digest: digestText(bytes)
	};
}
/** Test for a safe existing workspace file; missing is false and all other failures are loud. */
async function workspaceFileExists(root, relativePath) {
	try {
		const path = await resolveWorkspacePath(root, relativePath, { mustExist: true });
		if (!(await stat(path)).isFile()) throw new WorkspaceError("path exists but is not an ordinary file", relativePath);
		return true;
	} catch (error) {
		if (error instanceof WorkspaceError && error.message.startsWith("required path does not exist")) return false;
		throw error;
	}
}
/** Validate the three activation-time inputs without changing the workspace. */
async function snapshotWorkspace(cwd) {
	const root = await canonicalWorkspace(cwd);
	const problem = await readWorkspaceInput(root, "problem.md", { nonEmpty: true });
	let hint;
	if (await workspaceFileExists(root, "hint.md")) hint = await readWorkspaceInput(root, "hint.md", { nonEmpty: false });
	const solutionExists = await workspaceFileExists(root, "solution.md");
	return {
		root,
		problem,
		...hint === void 0 ? {} : { hint },
		solutionExists
	};
}
/** Create all AlphaSolve-owned directories and non-destructive knowledge skeleton files. */
async function initializeWorkspace(root) {
	const canonicalRoot = await canonicalWorkspace(root);
	for (const relativePath of WORKSPACE_DIRS) {
		const path = await resolveWorkspacePath(canonicalRoot, relativePath, { mustExist: false });
		try {
			await mkdir(path, {
				recursive: true,
				mode: 448
			});
			const canonical = await realpath(path);
			if (!isContained(canonicalRoot, canonical)) throw new WorkspaceError("created directory escaped the workspace", relativePath);
			if (!(await stat(canonical)).isDirectory()) throw new WorkspaceError("workspace path conflicts with a non-directory", relativePath);
		} catch (error) {
			if (error instanceof WorkspaceError) throw error;
			throw new WorkspaceError("unable to initialize workspace directory", relativePath, { cause: error });
		}
	}
	for (const [relativePath, content] of Object.entries({
		"knowledge/index.md": "# Knowledge Index\n",
		"knowledge/common-errors.md": "# Common Errors\n",
		"knowledge/references/index.md": "# Reference Index\n"
	})) {
		const path = await resolveWorkspacePath(canonicalRoot, relativePath, { mustExist: false });
		try {
			const handle = await open(path, "wx", 384);
			try {
				await handle.writeFile(content, "utf8");
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			const existing = await resolveWorkspacePath(canonicalRoot, relativePath, { mustExist: true });
			if (!(await stat(existing)).isFile()) throw new WorkspaceError("knowledge skeleton conflicts with a non-file", relativePath);
		}
	}
}
/** Atomically preserve an existing solution before an explicitly authorized overwrite. */
async function backupSolution(root, now = /* @__PURE__ */ new Date()) {
	if (!await workspaceFileExists(root, "solution.md")) return void 0;
	const source = await readWorkspaceInput(root, "solution.md", { nonEmpty: false });
	const relativePath = `.alphasolve/backups/solution-${now.toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID().slice(0, 8)}.md`;
	await atomicWriteText(await resolveWorkspacePath(root, relativePath, { mustExist: false }), source.content);
	return relativePath;
}
/** Capture an active proposition's identity for fail-closed external-edit detection. */
async function captureFileStamp(root, relativePath) {
	const path = await resolveWorkspacePath(root, relativePath, { mustExist: true });
	const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
	if (!info.isFile()) throw new WorkspaceError("active proposition is not an ordinary file", relativePath);
	return {
		digest: digestText(bytes),
		size: info.size,
		mtimeMs: info.mtimeMs
	};
}
/** Reject an active proposition that changed outside the role which owned it. */
async function assertFileStamp(root, relativePath, expected) {
	const actual = await captureFileStamp(root, relativePath);
	if (actual.digest !== expected.digest || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) throw new WorkspaceError("active proposition changed outside its owning role", relativePath);
}
//#endregion
//#region src/config.ts
/** Strict user/project configuration loading with the documented precedence. */
/** Resolve the fixed user-level configuration path. */
function userConfigPath(environment = process.env) {
	const explicit = environment.DSH_HOME;
	const dshHome = explicit === void 0 || explicit.trim() === "" ? join(homedir(), ".dsh") : explicit;
	return join(dshHome, "alphasolve.json");
}
/** Read a strict optional JSON config; missing is the only silent outcome. */
async function readOptionalConfig(path, containmentRoot) {
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw new TypeError(`${path}: unable to inspect configuration: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!info.isFile() && !info.isSymbolicLink()) throw new TypeError(`${path}: configuration is not an ordinary file`);
	if (containmentRoot !== void 0) {
		let canonical;
		try {
			canonical = await realpath(path);
		} catch (error) {
			throw new TypeError(`${path}: unable to resolve configuration: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!isContained(containmentRoot, canonical)) throw new WorkspaceError("configuration symlink escapes the workspace", path);
	}
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new TypeError(`${path}: unable to read configuration: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseModelConfigJson(text, path);
}
/** Load user and project layers and apply prompt > project > user > default capacity. */
async function loadAlphaSolveConfig(workspace, options = {}) {
	const userPath = userConfigPath(options.environment);
	const projectPath = await resolveWorkspacePath(workspace, ".alphasolve/config.json", { mustExist: false });
	const [user, project] = await Promise.all([readOptionalConfig(userPath), readOptionalConfig(projectPath, workspace)]);
	return {
		resolved: resolveAlphaSolveConfig({
			...options.promptCapacity === void 0 ? {} : { promptCapacity: options.promptCapacity },
			...options.defaultCapacity === void 0 ? {} : { defaultCapacity: options.defaultCapacity },
			...options.defaultDetailedTrace === void 0 ? {} : { defaultDetailedTrace: options.defaultDetailedTrace },
			...user === void 0 ? {} : { user },
			...project === void 0 ? {} : { project }
		}),
		userPath,
		projectPath,
		...user === void 0 ? {} : { user },
		...project === void 0 ? {} : { project }
	};
}
//#endregion
//#region src/curator-tools.ts
/** Filesystem primitives exposed to the AlphaSolve curator role. */
const KNOWLEDGE$1 = "knowledge";
const REFERENCES$1 = "knowledge/references";
const PROTECTED_FILE_NAMES = /* @__PURE__ */ new Set(["index.md", "common-errors.md"]);
const MUTATION_DIRECTORY = ".alphasolve/curator/mutations";
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
/** A curator-tool rejection whose message is safe to show to the role agent. */
var CuratorToolError = class extends Error {
	path;
	constructor(message, path, options) {
		super(path === void 0 ? message : `${message}: ${path}`, options);
		this.path = path;
		this.name = "CuratorToolError";
	}
};
function isRecord$2(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasExactKeys$2(value, keys) {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function expectedFileDigest(content) {
	return digestText(`file\0${digestText(content)}`);
}
function missingDigest() {
	return digestText("missing");
}
function emptyDirectoryDigest() {
	return digestText(JSON.stringify(["directory", []]));
}
function resourcesDigest(resources, field) {
	return digestText(JSON.stringify(resources.map((resource) => [resource.path, resource[field]])));
}
function parseMutationResult(value, journalPath) {
	if (!isRecord$2(value)) throw new DurableDataError("invalid curator mutation result", journalPath);
	if (hasExactKeys$2(value, ["path"]) && typeof value.path === "string" && value.path.length > 0) return { path: validateJournalKnowledgePath(value.path, journalPath) };
	if (hasExactKeys$2(value, ["paths"]) && Array.isArray(value.paths) && value.paths.length > 0 && value.paths.every((item) => typeof item === "string" && item.length > 0)) return { paths: value.paths.map((item) => validateJournalKnowledgePath(item, journalPath)) };
	throw new DurableDataError("invalid curator mutation result", journalPath);
}
function validateJournalKnowledgePath(value, journalPath) {
	let normalized;
	try {
		normalized = normalizeRelativePath(value);
	} catch (error) {
		throw new DurableDataError("invalid path in curator mutation journal", journalPath, { cause: error });
	}
	if (normalized !== value || !isKnowledgeRelative(normalized)) throw new DurableDataError("invalid path in curator mutation journal", journalPath);
	return normalized;
}
function parseMutationRecord(value, journalPath) {
	if (!isRecord$2(value) || !hasExactKeys$2(value, [
		"operationKey",
		"kind",
		"fingerprint",
		"beforeDigest",
		"afterDigest",
		"resources",
		"result",
		"status"
	])) throw new DurableDataError("invalid curator mutation record", journalPath);
	if (typeof value.operationKey !== "string" || value.operationKey.length === 0 || typeof value.kind !== "string" || ![
		"write",
		"edit",
		"mkdir",
		"rename",
		"move",
		"split_reference",
		"delete",
		"finalize_metadata"
	].includes(value.kind) || typeof value.fingerprint !== "string" || !HEX_DIGEST.test(value.fingerprint) || typeof value.beforeDigest !== "string" || !HEX_DIGEST.test(value.beforeDigest) || typeof value.afterDigest !== "string" || !HEX_DIGEST.test(value.afterDigest) || !Array.isArray(value.resources) || value.resources.length === 0 || value.status !== "prepared" && value.status !== "applied") throw new DurableDataError("invalid curator mutation record", journalPath);
	const resources = value.resources.map((item) => {
		if (!isRecord$2(item) || !hasExactKeys$2(item, [
			"path",
			"beforeDigest",
			"afterDigest"
		]) || typeof item.path !== "string" || item.path.length === 0 || typeof item.beforeDigest !== "string" || !HEX_DIGEST.test(item.beforeDigest) || typeof item.afterDigest !== "string" || !HEX_DIGEST.test(item.afterDigest)) throw new DurableDataError("invalid curator mutation resource", journalPath);
		return {
			path: validateJournalKnowledgePath(item.path, journalPath),
			beforeDigest: item.beforeDigest,
			afterDigest: item.afterDigest
		};
	});
	if (new Set(resources.map((resource) => resource.path)).size !== resources.length) throw new DurableDataError("duplicate curator mutation resource path", journalPath);
	if (resourcesDigest(resources, "beforeDigest") !== value.beforeDigest || resourcesDigest(resources, "afterDigest") !== value.afterDigest) throw new DurableDataError("curator mutation aggregate digest mismatch", journalPath);
	const result = parseMutationResult(value.result, journalPath);
	if (value.kind === "split_reference" !== (result.paths !== void 0)) throw new DurableDataError("curator mutation result does not match its operation kind", journalPath);
	if ((result.paths ?? (result.path === void 0 ? [] : [result.path])).some((resultPath) => !resources.some((resource) => resource.path === resultPath))) throw new DurableDataError("curator mutation result is not represented by its resources", journalPath);
	return {
		operationKey: value.operationKey,
		kind: value.kind,
		fingerprint: value.fingerprint,
		beforeDigest: value.beforeDigest,
		afterDigest: value.afterDigest,
		resources,
		result,
		status: value.status
	};
}
function parseMutationJournal(value, journalPath, taskId) {
	if (!isRecord$2(value) || !hasExactKeys$2(value, [
		"version",
		"taskId",
		"operations"
	]) || value.version !== 1 || value.taskId !== taskId || !Array.isArray(value.operations)) throw new DurableDataError("invalid curator mutation journal", journalPath);
	const operations = value.operations.map((item) => parseMutationRecord(item, journalPath));
	for (let index = 0; index < operations.length; index += 1) if (operations[index]?.operationKey !== `${taskId}:${index + 1}`) throw new DurableDataError("invalid curator mutation operation sequence", journalPath);
	const prepared = operations.findIndex((operation) => operation.status === "prepared");
	if (prepared >= 0 && prepared !== operations.length - 1) throw new DurableDataError("prepared curator mutation must be the final journal operation", journalPath);
	return {
		version: 1,
		taskId,
		operations
	};
}
function decodeUtf8$1(bytes, file) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new CuratorToolError("file is not valid UTF-8", file, { cause: error });
	}
}
function isMissing$3(error) {
	return error?.code === "ENOENT";
}
function isConflict$1(error) {
	const code = error?.code;
	return code === "EEXIST" || code === "ENOTEMPTY";
}
function toPosix(root, absolute) {
	return path.relative(root, absolute).split(path.sep).join("/");
}
function isKnowledgeRelative(relativePath) {
	return relativePath === KNOWLEDGE$1 || relativePath.startsWith(`${KNOWLEDGE$1}/`);
}
function isReferenceRelative(relativePath) {
	return relativePath === REFERENCES$1 || relativePath.startsWith(`${REFERENCES$1}/`);
}
function lineChunks(content) {
	if (content === "") return [];
	return content.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((chunk) => chunk.length > 0) ?? [];
}
function withIncrementedModificationCount(text) {
	let count = 1;
	let body = text;
	if (text.startsWith("---")) {
		const end = text.indexOf("\n---", 3);
		if (end >= 0) {
			const frontmatter = text.slice(3, end);
			body = text.slice(end + 4);
			const countLine = frontmatter.split(/\r\n|\n|\r/).find((line) => line.startsWith("modification_count:"));
			if (countLine !== void 0) {
				const parsed = Number(countLine.split(":", 2)[1]?.trim() ?? "");
				count = Number.isSafeInteger(parsed) ? parsed + 1 : 1;
			}
		}
	}
	if (!body.startsWith("\n")) body = `\n${body}`;
	return `---\nmodification_count: ${count}\n---${body}`;
}
function globRegex(pattern) {
	let source = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char === void 0) break;
		if (char === "*") if (pattern[index + 1] === "*") {
			index += 1;
			if (pattern[index + 1] === "/") {
				index += 1;
				source += "(?:.*/)?";
			} else source += ".*";
		} else source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += char.replace(/[\\^$.[\]{}()+|]/g, "\\$&");
	}
	return new RegExp(`${source}$`);
}
function plainName$1(value, label) {
	if (value.length === 0 || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) throw new CuratorToolError(`${label} must be one plain file or directory name`, value);
	return value;
}
/**
* Dedicated knowledge-only tools for a single curator task.
*
* There is deliberately no process/shell primitive. All mutating operations
* validate both the requested path and its canonical ancestry immediately
* before touching the filesystem.
*/
var CuratorKnowledgeTools = class CuratorKnowledgeTools {
	workspaceRoot;
	taskKind;
	taskId;
	knowledgeRoot;
	referencesRoot;
	journalPath;
	journal;
	/** DSH-style per-role observed versions used to reject blind/stale rewrites. */
	observed = /* @__PURE__ */ new Map();
	/** Successful curator mutations whose ordinary-entry metadata is finalized once. */
	touchedPaths = /* @__PURE__ */ new Set();
	metadataFinalized = false;
	operationCursor = 0;
	constructor(workspaceRoot, taskKind, taskId, knowledgeRoot, referencesRoot, journalPath, journal) {
		this.workspaceRoot = workspaceRoot;
		this.taskKind = taskKind;
		this.taskId = taskId;
		this.knowledgeRoot = knowledgeRoot;
		this.referencesRoot = referencesRoot;
		this.journalPath = journalPath;
		this.journal = journal;
	}
	static async create(workspaceRoot, taskKind, taskId = `standalone-${randomUUID()}`) {
		if (typeof taskId !== "string" || taskId.length === 0) throw new TypeError("curator task id must be a non-empty string");
		const root = await canonicalWorkspace(workspaceRoot);
		const knowledgeRoot = path.join(root, KNOWLEDGE$1);
		const referencesRoot = path.join(root, REFERENCES$1);
		try {
			const [canonicalKnowledge, canonicalReferences] = await Promise.all([realpath(knowledgeRoot), realpath(referencesRoot)]);
			const [knowledgeInfo, referenceInfo] = await Promise.all([stat(canonicalKnowledge), stat(canonicalReferences)]);
			if (!knowledgeInfo.isDirectory() || !referenceInfo.isDirectory()) throw new CuratorToolError("knowledge and references must be directories");
			if (!isContained(root, canonicalKnowledge) || !isContained(canonicalKnowledge, canonicalReferences)) throw new CuratorToolError("knowledge directory escapes the workspace");
			const mutationDirectory = path.join(root, ...MUTATION_DIRECTORY.split("/"));
			await mkdir(mutationDirectory, {
				recursive: true,
				mode: 448
			});
			const canonicalMutationDirectory = await realpath(mutationDirectory);
			if (canonicalMutationDirectory !== mutationDirectory || !isContained(root, canonicalMutationDirectory)) throw new CuratorToolError("curator mutation directory escapes the workspace", MUTATION_DIRECTORY);
			const journalPath = path.join(canonicalMutationDirectory, `${digestText(taskId)}.json`);
			let journal;
			try {
				const info = await lstat(journalPath);
				if (info.isSymbolicLink() || !info.isFile()) throw new DurableDataError("curator mutation journal must be an ordinary file", journalPath);
				journal = parseMutationJournal(await readJson(journalPath), journalPath, taskId);
			} catch (error) {
				if (!isMissing$3(error)) throw error;
				journal = {
					version: 1,
					taskId,
					operations: []
				};
				await atomicWriteJson(journalPath, journal);
			}
			return new CuratorKnowledgeTools(root, taskKind, taskId, canonicalKnowledge, canonicalReferences, journalPath, journal);
		} catch (error) {
			if (error instanceof CuratorToolError || error instanceof DurableDataError) throw error;
			throw new CuratorToolError("unable to initialize curator knowledge tools", KNOWLEDGE$1, { cause: error });
		}
	}
	async nearestExisting(target) {
		let cursor = target;
		for (;;) {
			try {
				await lstat(cursor);
				return cursor;
			} catch (error) {
				if (!isMissing$3(error)) throw error;
			}
			const parent = path.dirname(cursor);
			if (parent === cursor) throw new CuratorToolError("path has no existing ancestor", target);
			cursor = parent;
		}
	}
	async resolve(input, mustExist) {
		let relativePath;
		try {
			relativePath = normalizeRelativePath(input);
		} catch (error) {
			if (error instanceof WorkspaceError) throw new CuratorToolError(error.message, void 0, { cause: error });
			throw error;
		}
		if (!isKnowledgeRelative(relativePath)) throw new CuratorToolError("curator tools are restricted to knowledge/", input);
		const absolute = path.resolve(this.workspaceRoot, ...relativePath.split("/"));
		if (!isContained(this.knowledgeRoot, absolute)) throw new CuratorToolError("path escapes knowledge/", input);
		let exists = true;
		let canonicalAnchor;
		try {
			canonicalAnchor = await realpath(absolute);
		} catch (error) {
			if (!isMissing$3(error)) throw new CuratorToolError("unable to resolve path", input, { cause: error });
			exists = false;
			if (mustExist) throw new CuratorToolError("path does not exist", input, { cause: error });
			try {
				canonicalAnchor = await realpath(await this.nearestExisting(absolute));
			} catch (ancestorError) {
				if (ancestorError instanceof CuratorToolError) throw ancestorError;
				throw new CuratorToolError("unable to validate path ancestry", input, { cause: ancestorError });
			}
		}
		if (!isContained(this.knowledgeRoot, canonicalAnchor)) throw new CuratorToolError("symlink resolves outside knowledge/", input);
		const inReferences = isReferenceRelative(relativePath) || isContained(this.referencesRoot, canonicalAnchor);
		return {
			requested: input,
			relative: relativePath,
			absolute,
			canonicalAnchor,
			exists,
			inReferences
		};
	}
	async rejectFinalSymlink(target) {
		if (!target.exists) return;
		if ((await lstat(target.absolute)).isSymbolicLink()) throw new CuratorToolError("mutating a symbolic link is not allowed", target.requested);
	}
	rejectReferenceMutation(target) {
		if (target.inReferences) throw new CuratorToolError("knowledge/references is read-only except for exact reference splitting", target.requested);
	}
	rejectProtectedMutation(target, operation) {
		const name = path.basename(target.absolute);
		if (name === "common-errors.md" && operation === "write" && this.taskKind !== "verifier_final" && this.taskKind !== "health_check") throw new CuratorToolError("only verifier-final and health-check tasks may update common-errors.md", target.requested);
		if (operation === "destructive" && PROTECTED_FILE_NAMES.has(name)) throw new CuratorToolError("protected index/common-errors files cannot be renamed, moved, or deleted", target.requested);
	}
	async requireOrdinaryFile(target) {
		if (!(await lstat(target.absolute)).isFile()) throw new CuratorToolError("path is not an ordinary file", target.requested);
	}
	requireMarkdown(target) {
		if (path.extname(target.absolute).toLowerCase() !== ".md") throw new CuratorToolError("curator text mutations are restricted to Markdown files", target.requested);
	}
	observe(target, content) {
		this.observed.set(target.canonicalAnchor, digestText(content));
	}
	assertObserved(target, content) {
		const expected = this.observed.get(target.canonicalAnchor);
		if (expected === void 0) throw new CuratorToolError("existing file must be read before it is written or edited", target.requested);
		if (expected !== digestText(content)) throw new CuratorToolError("file changed since it was read; read it again before writing", target.requested);
	}
	recordTouch(absolutePath) {
		this.touchedPaths.add(path.resolve(absolutePath));
	}
	persistJournal() {
		return atomicWriteJson(this.journalPath, this.journal);
	}
	async stateDigestAbsolute(absolute) {
		let info;
		try {
			info = await lstat(absolute);
		} catch (error) {
			if (isMissing$3(error)) return missingDigest();
			throw error;
		}
		if (info.isFile()) return expectedFileDigest(await readFile(absolute));
		if (info.isDirectory()) return emptyDirectoryDigest();
		if (info.isSymbolicLink()) return digestText(JSON.stringify(["symlink", await readlink(absolute)]));
		return digestText(JSON.stringify([
			"other",
			info.mode,
			info.size
		]));
	}
	async stateDigest(relativePath) {
		const normalized = normalizeRelativePath(relativePath);
		const absolute = path.resolve(this.workspaceRoot, ...normalized.split("/"));
		if (!isContained(this.workspaceRoot, absolute)) throw new CuratorToolError("mutation journal path escapes the workspace", relativePath);
		const resolved = await this.resolve(normalized, false);
		return this.stateDigestAbsolute(resolved.absolute);
	}
	beginMutation(kind, args) {
		const index = this.operationCursor;
		if (this.journal.operations.slice(0, index).some((operation) => operation.status === "prepared")) throw new CuratorToolError("a previous curator mutation remains unresolved", this.taskId);
		const operationKey = `${this.taskId}:${index + 1}`;
		const fingerprint = digestText(JSON.stringify({
			kind,
			args
		}));
		const existing = this.journal.operations[index];
		if (existing !== void 0 && (existing.operationKey !== operationKey || existing.kind !== kind || existing.fingerprint !== fingerprint)) throw new CuratorToolError("curator mutation replay diverged from the durable operation", operationKey);
		if (existing !== void 0) this.operationCursor += 1;
		return {
			index,
			operationKey,
			kind,
			fingerprint,
			...existing === void 0 ? {} : { existing }
		};
	}
	async currentDigest(resources) {
		const current = await Promise.all(resources.map(async (resource) => ({
			...resource,
			currentDigest: await this.stateDigest(resource.path)
		})));
		return digestText(JSON.stringify(current.map((resource) => [resource.path, resource.currentDigest])));
	}
	async validateAppliedReplay(index, record) {
		for (const resource of record.resources) {
			const current = await this.stateDigest(resource.path);
			if (current === resource.afterDigest) continue;
			let latest;
			for (let laterIndex = index + 1; laterIndex < this.journal.operations.length; laterIndex += 1) {
				const laterRecord = this.journal.operations[laterIndex];
				const laterResource = laterRecord?.resources.find((item) => item.path === resource.path);
				if (laterRecord !== void 0 && laterResource !== void 0) latest = {
					record: laterRecord,
					resource: laterResource
				};
			}
			if (!(latest !== void 0 && (latest.record.status === "applied" ? current === latest.resource.afterDigest : current === latest.resource.beforeDigest || current === latest.resource.afterDigest))) throw new CuratorToolError("curator mutation replay conflicts with the current file state", record.operationKey);
		}
	}
	async resumeMutation(ticket, apply, onSuccess = () => void 0) {
		const record = ticket.existing;
		if (record === void 0) return { handled: false };
		if (record.status === "applied") {
			await this.validateAppliedReplay(ticket.index, record);
			await onSuccess();
			return {
				handled: true,
				result: record.result
			};
		}
		const current = await this.currentDigest(record.resources);
		if (current === record.afterDigest) {
			record.status = "applied";
			await this.persistJournal();
			await onSuccess();
			return {
				handled: true,
				result: record.result
			};
		}
		if (current !== record.beforeDigest) throw new CuratorToolError("curator mutation replay conflicts with the current file state", record.operationKey);
		await apply();
		if (await this.currentDigest(record.resources) !== record.afterDigest) throw new CuratorToolError("curator mutation did not produce its durable after state", record.operationKey);
		record.status = "applied";
		await this.persistJournal();
		await onSuccess();
		return {
			handled: true,
			result: record.result
		};
	}
	async prepareMutation(ticket, resources, result, apply, onSuccess = () => void 0) {
		if (ticket.existing !== void 0 || ticket.index !== this.journal.operations.length) throw new CuratorToolError("curator mutation journal sequence is inconsistent", ticket.operationKey);
		const record = {
			operationKey: ticket.operationKey,
			kind: ticket.kind,
			fingerprint: ticket.fingerprint,
			beforeDigest: resourcesDigest(resources, "beforeDigest"),
			afterDigest: resourcesDigest(resources, "afterDigest"),
			resources: resources.map((resource) => ({ ...resource })),
			result,
			status: "prepared"
		};
		this.journal.operations.push(record);
		this.operationCursor += 1;
		await this.persistJournal();
		await apply();
		if (await this.currentDigest(resources) !== record.afterDigest) throw new CuratorToolError("curator mutation did not produce its durable after state", ticket.operationKey);
		record.status = "applied";
		await this.persistJournal();
		await onSuccess();
		return result;
	}
	async observeMutationFile(relativePath, touch) {
		const target = await this.resolve(relativePath, false);
		if (touch) this.recordTouch(target.absolute);
		if (!target.exists || !(await lstat(target.absolute)).isFile()) return;
		const bytes = await readFile(target.absolute);
		this.observe(target, bytes);
	}
	/**
	* Apply AlphaSolve main's system-owned modification counter after one
	* curator task succeeds. Human references and routing/protected files keep
	* their exact text and never receive this frontmatter.
	*/
	async finalizeMetadata() {
		if (this.metadataFinalized) return;
		for (const touched of [...this.touchedPaths].sort()) {
			let canonical;
			let info;
			try {
				canonical = await realpath(touched);
				info = await lstat(touched);
			} catch (error) {
				if (isMissing$3(error)) continue;
				throw error;
			}
			if (info.isSymbolicLink() || !info.isFile() || path.extname(canonical).toLowerCase() !== ".md" || PROTECTED_FILE_NAMES.has(path.basename(canonical)) || !isContained(this.knowledgeRoot, canonical) || isContained(this.referencesRoot, canonical)) continue;
			const relative = toPosix(this.workspaceRoot, canonical);
			const ticket = this.beginMutation("finalize_metadata", { path: relative });
			const apply = async () => {
				const current = await this.resolve(relative, true);
				await this.requireOrdinaryFile(current);
				const text = decodeUtf8$1(await readFile(current.absolute), relative);
				await atomicWriteText(current.absolute, withIncrementedModificationCount(text));
			};
			if ((await this.resumeMutation(ticket, apply, () => this.observeMutationFile(relative, false))).handled) continue;
			const text = decodeUtf8$1(await readFile(canonical), relative);
			const next = withIncrementedModificationCount(text);
			await this.prepareMutation(ticket, [{
				path: relative,
				beforeDigest: expectedFileDigest(text),
				afterDigest: expectedFileDigest(next)
			}], { path: relative }, apply, () => this.observeMutationFile(relative, false));
		}
		if (this.journal.operations.some((operation) => operation.status === "prepared")) throw new CuratorToolError("a curator mutation remains unresolved", this.taskId);
		if (this.operationCursor !== this.journal.operations.length) throw new CuratorToolError("curator mutation replay ended before all durable operations were replayed", this.taskId);
		this.metadataFinalized = true;
	}
	async ensureDirectory(relativePath) {
		const normalized = normalizeRelativePath(relativePath);
		if (!isKnowledgeRelative(normalized)) throw new CuratorToolError("directory is outside knowledge/", relativePath);
		const components = normalized.split("/");
		let current = components[0];
		if (current === void 0) throw new CuratorToolError("invalid directory path", relativePath);
		let resolved = await this.resolve(current, true);
		for (const component of components.slice(1)) {
			current = `${current}/${component}`;
			resolved = await this.resolve(current, false);
			this.rejectReferenceMutation(resolved);
			if (resolved.exists) {
				if (!(await stat(resolved.absolute)).isDirectory()) throw new CuratorToolError("path component is not a directory", current);
				continue;
			}
			try {
				await mkdir(resolved.absolute, { mode: 448 });
			} catch (error) {
				if (!isConflict$1(error)) throw error;
			}
			resolved = await this.resolve(current, true);
			if (!(await stat(resolved.absolute)).isDirectory()) throw new CuratorToolError("path component is not a directory", current);
		}
		return resolved;
	}
	async read(relativePath, options = {}) {
		const target = await this.resolve(relativePath, true);
		await this.requireOrdinaryFile(target);
		const bytes = await readFile(target.absolute);
		const content = decodeUtf8$1(bytes, relativePath);
		this.observe(target, bytes);
		const lines = lineChunks(content);
		if (lines.length === 0 && options.startLine === void 0 && options.endLine === void 0) return {
			path: target.relative,
			content: "",
			startLine: 0,
			endLine: 0,
			totalLines: 0
		};
		const startLine = options.startLine ?? 1;
		const endLine = options.endLine ?? lines.length;
		if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) throw new CuratorToolError("invalid inclusive line range", relativePath);
		return {
			path: target.relative,
			content: lines.slice(startLine - 1, endLine).join(""),
			startLine,
			endLine,
			totalLines: lines.length
		};
	}
	async write(relativePath, content, options = {}) {
		let target = await this.resolve(relativePath, false);
		this.rejectReferenceMutation(target);
		this.rejectProtectedMutation(target, "write");
		this.requireMarkdown(target);
		await this.rejectFinalSymlink(target);
		const mode = options.mode ?? "overwrite";
		if (mode !== "overwrite" && mode !== "append") throw new CuratorToolError("invalid write mode", relativePath);
		const ticket = this.beginMutation("write", {
			path: target.relative,
			content,
			mode
		});
		const apply = async () => {
			let current = await this.resolve(relativePath, false);
			this.rejectReferenceMutation(current);
			this.rejectProtectedMutation(current, "write");
			this.requireMarkdown(current);
			await this.rejectFinalSymlink(current);
			if (!current.exists) {
				await this.ensureDirectory(toPosix(this.workspaceRoot, path.dirname(current.absolute)));
				current = await this.resolve(relativePath, false);
				if (current.exists) throw new CuratorToolError("target appeared before creation", relativePath);
				const handle = await open(current.absolute, "wx", 384);
				try {
					await handle.writeFile(content, "utf8");
				} finally {
					await handle.close();
				}
				return;
			}
			await this.requireOrdinaryFile(current);
			const currentBytes = await readFile(current.absolute);
			const nextContent = mode === "append" ? `${decodeUtf8$1(currentBytes, relativePath)}${content}` : content;
			await atomicWriteText(current.absolute, nextContent);
		};
		const resumed = await this.resumeMutation(ticket, apply, () => this.observeMutationFile(target.relative, true));
		if (resumed.handled) return resumed.result;
		let next = content;
		let beforeDigest = missingDigest();
		if (!target.exists) {} else {
			await this.requireOrdinaryFile(target);
			const currentBytes = await readFile(target.absolute);
			this.assertObserved(target, currentBytes);
			beforeDigest = expectedFileDigest(currentBytes);
			if (mode === "append") next = `${decodeUtf8$1(currentBytes, relativePath)}${content}`;
		}
		return this.prepareMutation(ticket, [{
			path: target.relative,
			beforeDigest,
			afterDigest: expectedFileDigest(next)
		}], { path: target.relative }, apply, () => this.observeMutationFile(target.relative, true));
	}
	async edit(relativePath, oldText, newText) {
		if (oldText.length === 0) throw new CuratorToolError("edit match must not be empty", relativePath);
		if (oldText === newText) throw new CuratorToolError("edit replacement must differ from its match", relativePath);
		const target = await this.resolve(relativePath, true);
		this.rejectReferenceMutation(target);
		this.rejectProtectedMutation(target, "write");
		this.requireMarkdown(target);
		await this.rejectFinalSymlink(target);
		await this.requireOrdinaryFile(target);
		const ticket = this.beginMutation("edit", {
			path: target.relative,
			oldText,
			newText
		});
		const apply = async () => {
			const current = await this.resolve(relativePath, true);
			this.rejectReferenceMutation(current);
			this.rejectProtectedMutation(current, "write");
			this.requireMarkdown(current);
			await this.rejectFinalSymlink(current);
			await this.requireOrdinaryFile(current);
			const currentText = decodeUtf8$1(await readFile(current.absolute), relativePath);
			const match = currentText.indexOf(oldText);
			if (match < 0) throw new CuratorToolError("edit match was not found", relativePath);
			if (currentText.indexOf(oldText, match + oldText.length) >= 0) throw new CuratorToolError("edit match is not unique", relativePath);
			await atomicWriteText(current.absolute, `${currentText.slice(0, match)}${newText}${currentText.slice(match + oldText.length)}`);
		};
		const resumed = await this.resumeMutation(ticket, apply, () => this.observeMutationFile(target.relative, true));
		if (resumed.handled) return resumed.result;
		const currentBytes = await readFile(target.absolute);
		this.assertObserved(target, currentBytes);
		const content = decodeUtf8$1(currentBytes, relativePath);
		const first = content.indexOf(oldText);
		if (first < 0) throw new CuratorToolError("edit match was not found", relativePath);
		if (content.indexOf(oldText, first + oldText.length) >= 0) throw new CuratorToolError("edit match is not unique", relativePath);
		const next = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
		return this.prepareMutation(ticket, [{
			path: target.relative,
			beforeDigest: expectedFileDigest(currentBytes),
			afterDigest: expectedFileDigest(next)
		}], { path: target.relative }, apply, () => this.observeMutationFile(target.relative, true));
	}
	async mkdir(relativePath) {
		const target = await this.resolve(relativePath, false);
		if (target.relative === KNOWLEDGE$1) throw new CuratorToolError("knowledge directory already exists", relativePath);
		this.rejectReferenceMutation(target);
		if (target.exists && !(await stat(target.absolute)).isDirectory()) throw new CuratorToolError("path component is not a directory", relativePath);
		const ticket = this.beginMutation("mkdir", { path: target.relative });
		const apply = async () => {
			await this.ensureDirectory(target.relative);
		};
		const resumed = await this.resumeMutation(ticket, apply);
		if (resumed.handled) return resumed.result;
		const beforeDigest = target.exists ? await this.stateDigest(target.relative) : missingDigest();
		return this.prepareMutation(ticket, [{
			path: target.relative,
			beforeDigest,
			afterDigest: target.exists ? beforeDigest : emptyDirectoryDigest()
		}], { path: target.relative }, apply);
	}
	async rename(directory, oldName, newName) {
		const oldPlain = plainName$1(oldName, "oldName");
		const newPlain = plainName$1(newName, "newName");
		if (PROTECTED_FILE_NAMES.has(oldPlain) || PROTECTED_FILE_NAMES.has(newPlain)) throw new CuratorToolError("protected index/common-errors files cannot be renamed, moved, or deleted");
		const source = await this.resolve(`${normalizeRelativePath(directory)}/${oldPlain}`, false);
		const target = await this.resolve(`${normalizeRelativePath(directory)}/${newPlain}`, false);
		this.rejectReferenceMutation(source);
		this.rejectReferenceMutation(target);
		this.rejectProtectedMutation(source, "destructive");
		this.rejectProtectedMutation(target, "destructive");
		await this.rejectFinalSymlink(source);
		const ticket = this.beginMutation("rename", {
			directory: normalizeRelativePath(directory),
			oldName: oldPlain,
			newName: newPlain
		});
		const apply = async () => {
			const currentSource = await this.resolve(source.relative, true);
			const currentTarget = await this.resolve(target.relative, false);
			this.rejectReferenceMutation(currentSource);
			this.rejectReferenceMutation(currentTarget);
			this.rejectProtectedMutation(currentSource, "destructive");
			this.rejectProtectedMutation(currentTarget, "destructive");
			await this.rejectFinalSymlink(currentSource);
			if (currentTarget.exists) throw new CuratorToolError("target already exists", currentTarget.relative);
			try {
				await rename(currentSource.absolute, currentTarget.absolute);
			} catch (error) {
				if (isConflict$1(error)) throw new CuratorToolError("target already exists", currentTarget.relative, { cause: error });
				throw error;
			}
		};
		const resumed = await this.resumeMutation(ticket, apply, () => this.recordTouch(target.absolute));
		if (resumed.handled) return resumed.result;
		if (!source.exists) throw new CuratorToolError("path does not exist", source.relative);
		if (target.exists) throw new CuratorToolError("target already exists", target.relative);
		const sourceDigest = await this.stateDigest(source.relative);
		return this.prepareMutation(ticket, [{
			path: source.relative,
			beforeDigest: sourceDigest,
			afterDigest: missingDigest()
		}, {
			path: target.relative,
			beforeDigest: missingDigest(),
			afterDigest: sourceDigest
		}], { path: target.relative }, apply, () => this.recordTouch(target.absolute));
	}
	async move(relativePath, destinationDirectory) {
		const source = await this.resolve(relativePath, false);
		const destination = await this.resolve(destinationDirectory, true);
		this.rejectReferenceMutation(source);
		this.rejectReferenceMutation(destination);
		this.rejectProtectedMutation(source, "destructive");
		await this.rejectFinalSymlink(source);
		if (!(await stat(destination.absolute)).isDirectory()) throw new CuratorToolError("move destination is not a directory", destinationDirectory);
		const target = await this.resolve(`${destination.relative}/${path.basename(source.absolute)}`, false);
		this.rejectReferenceMutation(target);
		this.rejectProtectedMutation(target, "destructive");
		const ticket = this.beginMutation("move", {
			path: source.relative,
			destinationDirectory: destination.relative
		});
		const apply = async () => {
			const currentSource = await this.resolve(source.relative, true);
			const currentDestination = await this.resolve(destination.relative, true);
			this.rejectReferenceMutation(currentSource);
			this.rejectReferenceMutation(currentDestination);
			this.rejectProtectedMutation(currentSource, "destructive");
			await this.rejectFinalSymlink(currentSource);
			await this.requireOrdinaryFile(currentSource);
			if (!(await stat(currentDestination.absolute)).isDirectory()) throw new CuratorToolError("move destination is not a directory", destinationDirectory);
			const currentTarget = await this.resolve(`${currentDestination.relative}/${path.basename(currentSource.absolute)}`, false);
			this.rejectReferenceMutation(currentTarget);
			this.rejectProtectedMutation(currentTarget, "destructive");
			if (currentTarget.exists) throw new CuratorToolError("target already exists", currentTarget.relative);
			try {
				await rename(currentSource.absolute, currentTarget.absolute);
			} catch (error) {
				if (isConflict$1(error)) throw new CuratorToolError("target already exists", currentTarget.relative, { cause: error });
				throw error;
			}
		};
		const resumed = await this.resumeMutation(ticket, apply, () => this.recordTouch(target.absolute));
		if (resumed.handled) return resumed.result;
		if (!source.exists) throw new CuratorToolError("path does not exist", source.relative);
		await this.requireOrdinaryFile(source);
		if (target.exists) throw new CuratorToolError("target already exists", target.relative);
		const sourceDigest = await this.stateDigest(source.relative);
		return this.prepareMutation(ticket, [{
			path: source.relative,
			beforeDigest: sourceDigest,
			afterDigest: missingDigest()
		}, {
			path: target.relative,
			beforeDigest: missingDigest(),
			afterDigest: sourceDigest
		}], { path: target.relative }, apply, () => this.recordTouch(target.absolute));
	}
	async splitReference(sourcePath, parts) {
		if (parts.length === 0) throw new CuratorToolError("at least one reference part is required", sourcePath);
		const source = await this.resolve(sourcePath, true);
		if (!source.inReferences) throw new CuratorToolError("reference source must be below knowledge/references", sourcePath);
		if (path.extname(source.absolute).toLowerCase() !== ".md") throw new CuratorToolError("reference source must be Markdown", sourcePath);
		await this.requireOrdinaryFile(source);
		const lines = lineChunks(decodeUtf8$1(await readFile(source.absolute), sourcePath));
		const targets = [];
		const partContents = [];
		const seen = /* @__PURE__ */ new Set();
		for (const part of parts) {
			if (!Number.isSafeInteger(part.startLine) || !Number.isSafeInteger(part.endLine) || part.startLine < 1 || part.endLine < part.startLine || part.endLine > lines.length) throw new CuratorToolError("invalid inclusive reference split range", part.path);
			const target = await this.resolve(part.path, false);
			if (!target.inReferences) throw new CuratorToolError("reference split target must stay below knowledge/references", part.path);
			if (path.extname(target.absolute).toLowerCase() !== ".md") throw new CuratorToolError("reference split target must be Markdown", part.path);
			if (path.basename(target.absolute) === "index.md") throw new CuratorToolError("reference split cannot create a protected index.md", part.path);
			if (seen.has(target.absolute)) throw new CuratorToolError("reference split target already exists", part.path);
			const parent = await this.resolve(toPosix(this.workspaceRoot, path.dirname(target.absolute)), true);
			if (!parent.inReferences || !(await stat(parent.absolute)).isDirectory()) throw new CuratorToolError("reference split target parent must be an existing reference directory", part.path);
			seen.add(target.absolute);
			targets.push(target);
			partContents.push(lines.slice(part.startLine - 1, part.endLine).join(""));
		}
		const ticket = this.beginMutation("split_reference", {
			sourcePath: source.relative,
			parts: parts.map((part) => ({ ...part }))
		});
		const apply = async () => {
			const created = [];
			try {
				for (let index = 0; index < targets.length; index += 1) {
					const target = targets[index];
					const partContent = partContents[index];
					if (target === void 0 || partContent === void 0) throw new Error("reference split validation mismatch");
					const current = await this.resolve(target.relative, false);
					if (!current.inReferences) throw new CuratorToolError("reference split target must stay below knowledge/references", current.relative);
					if (current.exists) throw new CuratorToolError("reference split target already exists", current.relative);
					const handle = await open(current.absolute, "wx", 384);
					try {
						await handle.writeFile(partContent, "utf8");
					} finally {
						await handle.close();
					}
					created.push(current.absolute);
				}
			} catch (error) {
				await Promise.all(created.map(async (createdPath) => {
					try {
						await unlink(createdPath);
					} catch {}
				}));
				if (isConflict$1(error)) throw new CuratorToolError("reference split target already exists", sourcePath, { cause: error });
				throw error;
			}
		};
		const onSuccess = () => {
			for (const target of targets) this.recordTouch(target.absolute);
		};
		const resumed = await this.resumeMutation(ticket, apply, onSuccess);
		if (resumed.handled) return resumed.result;
		for (const target of targets) if (target.exists) throw new CuratorToolError("reference split target already exists", target.relative);
		const sourceDigest = await this.stateDigest(source.relative);
		return this.prepareMutation(ticket, [{
			path: source.relative,
			beforeDigest: sourceDigest,
			afterDigest: sourceDigest
		}, ...targets.map((target, index) => ({
			path: target.relative,
			beforeDigest: missingDigest(),
			afterDigest: expectedFileDigest(partContents[index] ?? "")
		}))], { paths: targets.map((target) => target.relative) }, apply, onSuccess);
	}
	async delete(relativePath) {
		const target = await this.resolve(relativePath, false);
		if (target.relative === KNOWLEDGE$1) throw new CuratorToolError("knowledge root cannot be deleted", relativePath);
		this.rejectReferenceMutation(target);
		this.rejectProtectedMutation(target, "destructive");
		await this.rejectFinalSymlink(target);
		const ticket = this.beginMutation("delete", { path: target.relative });
		const apply = async () => {
			const current = await this.resolve(target.relative, true);
			this.rejectReferenceMutation(current);
			this.rejectProtectedMutation(current, "destructive");
			await this.rejectFinalSymlink(current);
			const info = await lstat(current.absolute);
			if (info.isDirectory()) try {
				await rmdir(current.absolute);
			} catch (error) {
				if (error?.code === "ENOTEMPTY") throw new CuratorToolError("directory must be empty before deletion", relativePath, { cause: error });
				throw error;
			}
			else if (info.isFile()) await unlink(current.absolute);
			else throw new CuratorToolError("only ordinary files and empty directories may be deleted", relativePath);
		};
		const resumed = await this.resumeMutation(ticket, apply);
		if (resumed.handled) return resumed.result;
		if (!target.exists) throw new CuratorToolError("path does not exist", relativePath);
		const info = await lstat(target.absolute);
		if (!info.isFile() && !info.isDirectory()) throw new CuratorToolError("only ordinary files and empty directories may be deleted", relativePath);
		if (info.isDirectory() && (await readdir(target.absolute)).length > 0) throw new CuratorToolError("directory must be empty before deletion", relativePath);
		return this.prepareMutation(ticket, [{
			path: target.relative,
			beforeDigest: await this.stateDigest(target.relative),
			afterDigest: missingDigest()
		}], { path: target.relative }, apply);
	}
	async list(relativePath = KNOWLEDGE$1) {
		const target = await this.resolve(relativePath, true);
		if (!(await stat(target.absolute)).isDirectory()) throw new CuratorToolError("path is not a directory", relativePath);
		return (await readdir(target.absolute, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name)).map((entry) => ({
			path: `${target.relative}/${entry.name}`,
			type: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other"
		}));
	}
	async walk(relativePath = KNOWLEDGE$1) {
		const found = [];
		const pending = [relativePath];
		while (pending.length > 0) {
			const current = pending.pop();
			if (current === void 0) break;
			for (const entry of await this.list(current)) if (entry.type === "directory") pending.push(entry.path);
			else if (entry.type === "file") found.push(entry.path);
		}
		return found.sort();
	}
	async glob(pattern) {
		const normalized = normalizeRelativePath(pattern);
		if (!isKnowledgeRelative(normalized)) throw new CuratorToolError("glob is restricted to knowledge/", pattern);
		const matcher = globRegex(normalized);
		return (await this.walk()).filter((file) => matcher.test(file));
	}
	async grep(query, options = {}) {
		if (query.length === 0) throw new CuratorToolError("grep query must not be empty");
		const root = options.path ?? KNOWLEDGE$1;
		const target = await this.resolve(root, true);
		const files = (await stat(target.absolute)).isFile() ? [target.relative] : await this.walk(target.relative);
		const needle = options.caseSensitive === false ? query.toLocaleLowerCase() : query;
		const maxResults = options.maxResults ?? 200;
		if (!Number.isSafeInteger(maxResults) || maxResults < 1) throw new CuratorToolError("maxResults must be a positive integer");
		const matches = [];
		for (const file of files) {
			const lines = decodeUtf8$1(await readFile((await this.resolve(file, true)).absolute), file).split(/\r\n|\n|\r/);
			for (let index = 0; index < lines.length; index += 1) {
				const text = lines[index];
				if (text === void 0) continue;
				if ((options.caseSensitive === false ? text.toLocaleLowerCase() : text).includes(needle)) matches.push({
					path: file,
					line: index + 1,
					text
				});
				if (matches.length >= maxResults) return matches;
			}
		}
		return matches;
	}
};
async function createCuratorKnowledgeTools(workspaceRoot, taskKind, taskId) {
	return CuratorKnowledgeTools.create(workspaceRoot, taskKind, taskId);
}
//#endregion
//#region src/curator.ts
/** Durable, single-consumer curator queue. */
const QUEUE_RELATIVE_PATH = ".alphasolve/curator/queue.json";
const HEALTH_CHECK_INTERVAL = 4;
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasExactKeys$1(value, required, optional = []) {
	const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
	return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}
function requireTracePath$1(value, queuePath) {
	let normalized;
	try {
		normalized = normalizeRelativePath(value);
	} catch (error) {
		if (queuePath !== void 0) throw new DurableDataError("invalid curator trace path", queuePath, { cause: error });
		throw new TypeError(`curator trace path must be canonical below .alphasolve/traces/: ${value}`, { cause: error });
	}
	const prefix = ".alphasolve/traces/";
	const basename = normalized.slice(19);
	if (normalized !== value || !normalized.startsWith(prefix) || basename.length === 0 || basename.includes("/") || path.extname(basename) !== ".json") {
		if (queuePath !== void 0) throw new DurableDataError("invalid curator trace path", queuePath);
		throw new TypeError(`curator trace path must be one canonical JSON file below .alphasolve/traces/: ${value}`);
	}
	return normalized;
}
function validOptionalString(value) {
	return value === void 0 || typeof value === "string" && value.length > 0;
}
function parseTask(value, queuePath) {
	if (!isRecord$1(value) || !hasExactKeys$1(value, [
		"version",
		"id",
		"kind",
		"createdAt",
		"status",
		"attempts"
	], [
		"sourceWorkerId",
		"tracePath",
		"metadata",
		"lastError"
	])) throw new DurableDataError("curator task must be an exact-schema object", queuePath);
	if (value.version !== 1 || typeof value.id !== "string" || value.id.length === 0 || typeof value.kind !== "string" || ![
		"digest",
		"verifier_final",
		"health_check"
	].includes(value.kind) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.status !== "string" || ![
		"pending",
		"active",
		"completed",
		"failed"
	].includes(value.status) || !Number.isSafeInteger(value.attempts) || value.attempts < 0 || !validOptionalString(value.sourceWorkerId) || !validOptionalString(value.tracePath) || !validOptionalString(value.lastError)) throw new DurableDataError("invalid curator task", queuePath);
	let metadata;
	if (value.metadata !== void 0) {
		if (!isRecord$1(value.metadata) || Object.values(value.metadata).some((item) => typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean")) throw new DurableDataError("invalid curator task metadata", queuePath);
		metadata = Object.freeze({ ...value.metadata });
	}
	const tracePath = value.tracePath === void 0 ? void 0 : requireTracePath$1(value.tracePath, queuePath);
	return Object.freeze({
		version: 1,
		id: value.id,
		kind: value.kind,
		createdAt: value.createdAt,
		...value.sourceWorkerId === void 0 ? {} : { sourceWorkerId: value.sourceWorkerId },
		...tracePath === void 0 ? {} : { tracePath },
		...metadata === void 0 ? {} : { metadata },
		status: value.status,
		attempts: value.attempts,
		...value.lastError === void 0 ? {} : { lastError: value.lastError }
	});
}
function parseQueueFile(value, queuePath) {
	if (!isRecord$1(value) || !hasExactKeys$1(value, ["version", "tasks"]) || value.version !== 1 || !Array.isArray(value.tasks)) throw new DurableDataError("invalid curator queue file", queuePath);
	const tasks = value.tasks.map((task) => parseTask(task, queuePath));
	const ids = /* @__PURE__ */ new Set();
	for (const task of tasks) {
		if (ids.has(task.id)) throw new DurableDataError("duplicate curator task id", queuePath);
		ids.add(task.id);
	}
	return {
		version: 1,
		tasks
	};
}
async function validateTraceArtifact(workspaceRoot, tracePath) {
	const normalized = requireTracePath$1(tracePath);
	const tracesDirectory = await resolveWorkspacePath(workspaceRoot, ".alphasolve/traces", { mustExist: true });
	const canonicalTraces = await realpath(tracesDirectory);
	if (canonicalTraces !== path.join(workspaceRoot, ".alphasolve", "traces") || !isContained(workspaceRoot, canonicalTraces)) throw new WorkspaceError("curator trace directory escapes workspace", ".alphasolve/traces");
	const absolute = path.join(workspaceRoot, ...normalized.split("/"));
	let info;
	try {
		info = await lstat(absolute);
	} catch (error) {
		throw new WorkspaceError("curator trace does not exist", normalized, { cause: error });
	}
	if (info.isSymbolicLink() || !info.isFile()) throw new WorkspaceError("curator trace must be an ordinary non-symlink JSON file", normalized);
	const canonical = await realpath(absolute);
	if (path.dirname(canonical) !== canonicalTraces || !isContained(canonicalTraces, canonical)) throw new WorkspaceError("curator trace escapes its canonical directory", normalized);
	await readJson(canonical);
}
function taskCopy(task) {
	return {
		...task,
		...task.metadata === void 0 ? {} : { metadata: { ...task.metadata } }
	};
}
function errorMessage$1(error) {
	if (error instanceof Error && error.message.length > 0) return error.message;
	return String(error);
}
function isMissing$2(error) {
	return error?.code === "ENOENT";
}
async function readQueueFromCanonicalDirectory(workspaceRoot, canonicalDirectory, queuePath) {
	let info;
	try {
		info = await lstat(queuePath);
	} catch (error) {
		if (isMissing$2(error)) return void 0;
		throw error;
	}
	if (info.isSymbolicLink() || !info.isFile()) throw new DurableDataError("curator queue must be an ordinary non-symlink file", queuePath);
	const canonicalQueue = await realpath(queuePath);
	if (path.dirname(canonicalQueue) !== canonicalDirectory || !isContained(workspaceRoot, canonicalQueue)) throw new WorkspaceError("curator queue escapes its state directory", QUEUE_RELATIVE_PATH);
	return parseQueueFile(await readJson(canonicalQueue), canonicalQueue);
}
function timeoutPromise(milliseconds) {
	let timer;
	return {
		promise: new Promise((resolve) => {
			timer = setTimeout(resolve, milliseconds);
			timer.unref?.();
		}),
		cancel: () => {
			if (timer !== void 0) clearTimeout(timer);
		}
	};
}
/**
* A durable FIFO which serializes curator role invocations.
*
* `open()` immediately starts the consumer. A process restart converts any
* persisted `active` item back to `pending`, so that the whole idempotent task
* is replayed from its beginning.
*/
var DurableCurator = class DurableCurator {
	workspaceRoot;
	queuePath;
	tasks;
	runner;
	idFactory;
	now;
	onTaskFailure;
	drainTimeoutMs;
	mutationTail = Promise.resolve();
	accepting = true;
	timedOut = false;
	waiter;
	activeDispatch;
	idleWaiters = /* @__PURE__ */ new Set();
	loopPromise;
	stopPromise;
	constructor(workspaceRoot, queuePath, tasks, options) {
		this.workspaceRoot = workspaceRoot;
		this.queuePath = queuePath;
		this.tasks = tasks;
		this.runner = options.runner;
		this.idFactory = options.idFactory ?? (() => randomUUID());
		this.now = options.now ?? (() => /* @__PURE__ */ new Date());
		this.onTaskFailure = options.onTaskFailure ?? (() => void 0);
		this.drainTimeoutMs = options.drainTimeoutMs ?? 6e4;
		if (!Number.isSafeInteger(this.drainTimeoutMs) || this.drainTimeoutMs < 0) throw new TypeError("drainTimeoutMs must be a non-negative safe integer");
		this.loopPromise = this.consume();
	}
	static async open(options) {
		const workspaceRoot = await canonicalWorkspace(options.workspaceRoot);
		const curatorDirectory = await resolveWorkspacePath(workspaceRoot, ".alphasolve/curator", { mustExist: false });
		await mkdir(curatorDirectory, {
			recursive: true,
			mode: 448
		});
		const canonicalDirectory = await realpath(curatorDirectory);
		if (canonicalDirectory !== path.join(workspaceRoot, ".alphasolve", "curator") || !isContained(workspaceRoot, canonicalDirectory)) throw new WorkspaceError("curator state directory escapes workspace", ".alphasolve/curator");
		const queuePath = path.join(curatorDirectory, "queue.json");
		let tasks = [];
		const queue = await readQueueFromCanonicalDirectory(workspaceRoot, canonicalDirectory, queuePath);
		if (queue !== void 0) {
			tasks = queue.tasks.map((task) => task.status === "active" ? {
				...task,
				status: "pending"
			} : taskCopy(task));
			await atomicWriteJson(queuePath, {
				version: 1,
				tasks
			});
		} else await atomicWriteJson(queuePath, {
			version: 1,
			tasks
		});
		return new DurableCurator(workspaceRoot, queuePath, tasks, options);
	}
	exclusive(operation) {
		const result = this.mutationTail.then(operation);
		this.mutationTail = result.then(() => void 0, () => void 0);
		return result;
	}
	persist() {
		return atomicWriteJson(this.queuePath, {
			version: 1,
			tasks: this.tasks
		});
	}
	generateId(prefix = "curator") {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const value = this.idFactory();
			if (typeof value !== "string" || value.length === 0) throw new TypeError("idFactory must return a non-empty string");
			const id = `${prefix}-${value}`;
			if (!this.tasks.some((task) => task.id === id)) return id;
		}
		throw new Error("unable to generate a unique curator task id");
	}
	wakeConsumer() {
		const wake = this.waiter;
		this.waiter = void 0;
		wake?.();
	}
	notifyIdleIfNeeded() {
		if (this.tasks.some((task) => task.status === "pending" || task.status === "active")) return;
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters.clear();
	}
	digestCountSinceHealthCheck() {
		let count = 0;
		for (let index = this.tasks.length - 1; index >= 0; index -= 1) {
			const task = this.tasks[index];
			if (task?.kind === "health_check") break;
			if (task?.kind === "digest") count += 1;
		}
		return count;
	}
	async submit(input) {
		return this.exclusive(async () => {
			if (!this.accepting) throw new Error("curator queue is frozen and does not accept new tasks");
			const tracePath = input.tracePath === void 0 ? void 0 : requireTracePath$1(input.tracePath);
			if (input.id !== void 0) {
				if (input.id.length === 0) throw new TypeError("task id must not be empty");
				const existing = this.tasks.find((task) => task.id === input.id);
				if (existing !== void 0) {
					if (existing.kind !== input.kind || existing.sourceWorkerId !== input.sourceWorkerId || existing.tracePath !== tracePath || JSON.stringify(existing.metadata ?? {}) !== JSON.stringify(input.metadata ?? {})) throw new Error(`curator task id conflicts with a different task: ${input.id}`);
					return taskCopy(existing);
				}
			}
			if (input.metadata !== void 0 && Object.values(input.metadata).some((value) => typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")) throw new TypeError("curator task metadata values must be strings, numbers, or booleans");
			const task = {
				version: 1,
				id: input.id ?? this.generateId(),
				kind: input.kind,
				createdAt: this.now().toISOString(),
				...input.sourceWorkerId === void 0 ? {} : { sourceWorkerId: input.sourceWorkerId },
				...tracePath === void 0 ? {} : { tracePath },
				...input.metadata === void 0 ? {} : { metadata: { ...input.metadata } },
				status: "pending",
				attempts: 0
			};
			this.tasks.push(task);
			if (task.kind === "digest" && this.digestCountSinceHealthCheck() >= HEALTH_CHECK_INTERVAL) this.tasks.push({
				version: 1,
				id: this.generateId("curator-health"),
				kind: "health_check",
				createdAt: this.now().toISOString(),
				status: "pending",
				attempts: 0
			});
			await this.persist();
			this.wakeConsumer();
			return taskCopy(task);
		});
	}
	acquireNext() {
		return this.exclusive(async () => {
			if (this.timedOut) return { kind: "stop" };
			const index = this.tasks.findIndex((task) => task.status === "pending");
			if (index >= 0) {
				const pending = this.tasks[index];
				if (pending === void 0) throw new Error("curator queue index disappeared");
				const active = {
					...pending,
					status: "active",
					attempts: pending.attempts + 1,
					...pending.lastError === void 0 ? {} : { lastError: pending.lastError }
				};
				this.tasks[index] = active;
				await this.persist();
				const dispatch = {
					kind: "task",
					task: taskCopy(active),
					controller: new AbortController(),
					generation: Symbol(active.id)
				};
				this.activeDispatch = dispatch;
				return dispatch;
			}
			this.notifyIdleIfNeeded();
			if (!this.accepting) return { kind: "stop" };
			let wake;
			const promise = new Promise((resolve) => {
				wake = resolve;
			});
			this.waiter = wake;
			return {
				kind: "wait",
				promise
			};
		});
	}
	async settle(dispatch, failure) {
		await this.exclusive(async () => {
			if (this.timedOut || this.activeDispatch?.generation !== dispatch.generation) return;
			const index = this.tasks.findIndex((task) => task.id === dispatch.task.id);
			const active = this.tasks[index];
			if (index < 0 || active === void 0 || active.status !== "active") throw new Error(`active curator task disappeared: ${dispatch.task.id}`);
			this.tasks[index] = failure === void 0 ? {
				...active,
				status: "completed"
			} : {
				...active,
				status: "failed",
				lastError: errorMessage$1(failure)
			};
			this.activeDispatch = void 0;
			await this.persist();
			this.notifyIdleIfNeeded();
		});
	}
	async consume() {
		for (;;) {
			const action = await this.acquireNext();
			if (action.kind === "stop") return;
			if (action.kind === "wait") {
				await action.promise;
				continue;
			}
			let failure;
			try {
				if (action.task.tracePath !== void 0) await validateTraceArtifact(this.workspaceRoot, action.task.tracePath);
				const tools = await createCuratorKnowledgeTools(this.workspaceRoot, action.task.kind, action.task.id);
				await this.runner({
					task: taskCopy(action.task),
					tools,
					signal: action.controller.signal
				});
				await tools.finalizeMetadata();
			} catch (error) {
				failure = error;
			}
			await this.settle(action, failure);
			if (failure !== void 0) try {
				this.onTaskFailure(taskCopy(action.task), failure);
			} catch {}
			if (this.timedOut) return;
		}
	}
	/** Return a detached immutable view in durable FIFO order. */
	snapshot() {
		return this.exclusive(() => this.tasks.map(taskCopy));
	}
	/** Wait until the current queue has neither pending nor active work. */
	async waitForIdle() {
		await (await this.exclusive(() => {
			if (!this.tasks.some((task) => task.status === "pending" || task.status === "active")) return void 0;
			let wake;
			const promise = new Promise((resolve) => {
				wake = resolve;
			});
			if (wake !== void 0) this.idleWaiters.add(wake);
			return { promise };
		}))?.promise;
	}
	/** Freeze submissions immediately, then drain FIFO work for at most the configured bound. */
	stop(options = {}) {
		this.stopPromise ??= this.stopOnce(options.timeoutMs ?? this.drainTimeoutMs);
		return this.stopPromise;
	}
	async stopOnce(timeoutMs) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new TypeError("timeoutMs must be a non-negative safe integer");
		await this.exclusive(() => {
			this.accepting = false;
			this.wakeConsumer();
		});
		const timeout = timeoutPromise(timeoutMs);
		const drained = await Promise.race([this.loopPromise.then(() => true), timeout.promise.then(() => false)]);
		timeout.cancel();
		if (!drained) {
			this.timedOut = true;
			this.activeDispatch?.controller.abort(/* @__PURE__ */ new Error("curator drain timeout expired"));
			await this.exclusive(async () => {
				const activeId = this.activeDispatch?.task.id;
				if (activeId !== void 0) {
					const index = this.tasks.findIndex((task) => task.id === activeId);
					const active = this.tasks[index];
					if (index >= 0 && active?.status === "active") this.tasks[index] = {
						...active,
						status: "pending"
					};
				}
				this.activeDispatch = void 0;
				await this.persist();
				this.notifyIdleIfNeeded();
				this.wakeConsumer();
			});
		}
		const tasks = await this.snapshot();
		return {
			drained,
			pending: tasks.filter((task) => task.status === "pending").length,
			active: tasks.filter((task) => task.status === "active").length,
			failed: tasks.filter((task) => task.status === "failed").length
		};
	}
};
/** Strict read-only recovery probe used before terminal-session teardown. */
async function hasRecoverableCuratorTasks(workspace) {
	const workspaceRoot = await canonicalWorkspace(workspace);
	let curatorDirectory;
	try {
		curatorDirectory = await resolveWorkspacePath(workspaceRoot, ".alphasolve/curator", { mustExist: true });
	} catch (error) {
		if (error instanceof WorkspaceError && error.message.startsWith("required path does not exist")) return false;
		throw error;
	}
	const canonicalDirectory = await realpath(curatorDirectory);
	if (canonicalDirectory !== path.join(workspaceRoot, ".alphasolve", "curator") || !isContained(workspaceRoot, canonicalDirectory) || !(await lstat(canonicalDirectory)).isDirectory()) throw new WorkspaceError("curator state directory escapes workspace", ".alphasolve/curator");
	return (await readQueueFromCanonicalDirectory(workspaceRoot, canonicalDirectory, path.join(canonicalDirectory, "queue.json")))?.tasks.some((task) => task.status === "pending" || task.status === "active") ?? false;
}
//#endregion
//#region src/lock.ts
/** Cross-session and cross-process ownership lock for one canonical workspace. */
const LOCK_VERSION = 2;
/** A live session already owns this canonical project directory. */
var WorkspaceBusyError = class extends Error {
	owner;
	constructor(owner) {
		super(`workspace is already owned by AlphaSolve session ${owner.sessionId} (pid ${owner.pid})`);
		this.owner = owner;
		this.name = "WorkspaceBusyError";
	}
};
/** A lock exists but cannot be trusted or recovered automatically. */
var WorkspaceLockError = class extends Error {
	path;
	constructor(message, path, options) {
		super(`${message}: ${path}`, options);
		this.path = path;
		this.name = "WorkspaceLockError";
	}
};
const ownedInProcess = /* @__PURE__ */ new Map();
function hasExactKeys(record, expected) {
	const keys = Object.keys(record).sort();
	const sortedExpected = [...expected].sort();
	return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}
function commonFieldsAreValid(record) {
	return typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0 && typeof record.sessionId === "string" && record.sessionId !== "" && typeof record.token === "string" && record.token !== "" && typeof record.workspace === "string" && record.workspace !== "" && typeof record.acquiredAt === "string" && !Number.isNaN(Date.parse(record.acquiredAt));
}
function parseProcessIdentity(value, path) {
	if (value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) throw new WorkspaceLockError("lock process identity is invalid", path);
	const identity = value;
	if (!hasExactKeys(identity, ["bootId", "startTimeTicks"]) || typeof identity.bootId !== "string" || identity.bootId.trim() === "" || typeof identity.startTimeTicks !== "string" || !/^\d+$/.test(identity.startTimeTicks)) throw new WorkspaceLockError("lock process identity is invalid", path);
	return identity;
}
/** Validate the untrusted persisted lock document. */
function parseLock(text, path) {
	let value;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new WorkspaceLockError("lock JSON is malformed; explicit repair is required", path, { cause: error });
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceLockError("lock JSON root is invalid", path);
	const record = value;
	const commonKeys = [
		"acquiredAt",
		"pid",
		"sessionId",
		"token",
		"version",
		"workspace"
	];
	if (!commonFieldsAreValid(record)) throw new WorkspaceLockError("lock JSON fields are invalid", path);
	if (record.version === LOCK_VERSION) {
		if (!hasExactKeys(record, [...commonKeys, "processIdentity"])) throw new WorkspaceLockError("lock JSON has unknown or missing fields", path);
		return {
			...record,
			processIdentity: parseProcessIdentity(record.processIdentity, path)
		};
	}
	throw new WorkspaceLockError("lock JSON version is unsupported", path);
}
/** Read an existing lock without following a planted symlink. */
async function readLock(path) {
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		throw error;
	}
	if (info.isSymbolicLink() || !info.isFile()) throw new WorkspaceLockError("lock path is not an ordinary non-symlink file", path);
	return parseLock(await readFile(path, "utf8"), path);
}
/** Conservatively decide whether the recorded process still exists. */
function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		return true;
	}
}
function parseProcStat(text, expectedPid) {
	const openParen = text.indexOf("(");
	const closeParen = text.lastIndexOf(")");
	if (openParen <= 0 || closeParen <= openParen) return void 0;
	if (Number(text.slice(0, openParen).trim()) !== expectedPid) return void 0;
	const fields = text.slice(closeParen + 1).trim().split(/\s+/);
	const state = fields[0];
	const startTimeTicks = fields[19];
	if (state === void 0 || state.length !== 1 || startTimeTicks === void 0 || !/^\d+$/.test(startTimeTicks)) return;
	return {
		state,
		startTimeTicks
	};
}
function parseStatusId(text, name) {
	const match = new RegExp(`^${name}:\\s+(\\d+)\\s*$`, "m").exec(text);
	if (match?.[1] === void 0) return void 0;
	const value = Number(match[1]);
	return Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
/** Read the exact Linux process identity without accepting a secondary thread ID. */
function readLinuxProcessSnapshot(pid) {
	if (process.platform !== "linux") return void 0;
	try {
		const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"), pid);
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		const statusPid = parseStatusId(status, "Pid");
		const tgid = parseStatusId(status, "Tgid");
		if (stat === void 0 || statusPid !== pid || tgid === void 0) return void 0;
		let bootId;
		try {
			bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || void 0;
		} catch (_unreadableBootId) {}
		return {
			...stat,
			tgid,
			bootId
		};
	} catch (_unreadableProcEntry) {
		return;
	}
}
function currentProcessIdentity() {
	const snapshot = readLinuxProcessSnapshot(process.pid);
	if (snapshot === void 0 || snapshot.tgid !== process.pid || snapshot.bootId === void 0) return null;
	return {
		bootId: snapshot.bootId,
		startTimeTicks: snapshot.startTimeTicks
	};
}
/** Match the persisted owner to the exact process, not merely a live PID/TID. */
function isLockOwnerAlive(owner) {
	if (!isProcessAlive(owner.pid)) return false;
	if (process.platform !== "linux") return true;
	const snapshot = readLinuxProcessSnapshot(owner.pid);
	if (snapshot === void 0) return true;
	if (snapshot.tgid !== owner.pid || snapshot.state === "Z" || snapshot.state === "X") return false;
	if (owner.processIdentity === null || snapshot.bootId === void 0) return true;
	return owner.processIdentity.bootId === snapshot.bootId && owner.processIdentity.startTimeTicks === snapshot.startTimeTicks;
}
function staleOwnerLabel(owner) {
	return createHash("sha256").update(owner.token).digest("hex").slice(0, 16);
}
async function sameInode(firstPath, secondPath) {
	try {
		const [first, second] = await Promise.all([lstat(firstPath, { bigint: true }), lstat(secondPath, { bigint: true })]);
		return first.isFile() && second.isFile() && first.dev === second.dev && first.ino === second.ino;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}
/**
* Elect exactly one stale-lock recoverer with a deterministic hard-link claim.
* The source remains present until the winner has pinned and revalidated its
* inode. Losers never unlink or rename the source path.
*/
async function recoverStaleOwner(canonical, lockPath, observedOwner) {
	const label = staleOwnerLabel(observedOwner);
	const claimPath = await resolveWorkspacePath(canonical, `.alphasolve/backups/.stale-lock-recovery-${label}.claim`, { mustExist: false });
	try {
		await link(lockPath, claimPath);
	} catch (error) {
		const code = error.code;
		if (code === "EEXIST" || code === "ENOENT") return false;
		throw error;
	}
	let sourceUnlinked = false;
	try {
		const claimedOwner = await readLock(claimPath);
		if (claimedOwner.token !== observedOwner.token || claimedOwner.workspace !== canonical) return false;
		if (!await sameInode(claimPath, lockPath)) return false;
		let currentOwner;
		try {
			currentOwner = await readLock(lockPath);
		} catch (error) {
			if (error.code === "ENOENT") return false;
			throw error;
		}
		if (currentOwner.token !== claimedOwner.token || currentOwner.workspace !== canonical) return false;
		if (isLockOwnerAlive(currentOwner)) throw new WorkspaceBusyError(currentOwner);
		if (!await sameInode(claimPath, lockPath)) return false;
		await unlink(lockPath);
		sourceUnlinked = true;
		await void 0;
		const stalePath = await resolveWorkspacePath(canonical, `.alphasolve/backups/stale-lock-${Date.now()}-${label}-${randomUUID().slice(0, 8)}.json`, { mustExist: false });
		await rename(claimPath, stalePath);
		await atomicWriteJson(`${stalePath}.recovery.json`, {
			recoveredAt: (/* @__PURE__ */ new Date()).toISOString(),
			recoveredByPid: process.pid,
			previousOwner: claimedOwner
		});
		return true;
	} finally {
		if (!sourceUnlinked) try {
			await unlink(claimPath);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
}
/** Acquire the one-session-per-canonical-directory lock, recovering dead owners only. */
async function acquireWorkspaceLock(workspace, sessionId) {
	if (sessionId.trim() === "") throw new TypeError("sessionId must not be empty");
	const canonical = await canonicalWorkspace(workspace);
	const lockPath = await resolveWorkspacePath(canonical, ".alphasolve/lock.json", { mustExist: false });
	const inProcess = ownedInProcess.get(canonical);
	if (inProcess !== void 0) throw new WorkspaceBusyError(inProcess);
	const record = {
		version: LOCK_VERSION,
		pid: process.pid,
		sessionId,
		token: randomUUID(),
		workspace: canonical,
		acquiredAt: (/* @__PURE__ */ new Date()).toISOString(),
		processIdentity: currentProcessIdentity()
	};
	for (let attempt = 0; attempt < 16; attempt += 1) {
		let created = false;
		try {
			const handle = await open(lockPath, "wx", 384);
			created = true;
			try {
				await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
			} finally {
				await handle.close();
			}
			ownedInProcess.set(canonical, record);
			let released = false;
			return {
				workspace: canonical,
				sessionId,
				token: record.token,
				path: lockPath,
				async assertOwned() {
					if (released) throw new WorkspaceLockError("workspace lock was already released", lockPath);
					const current = await readLock(lockPath);
					if (current.token !== record.token || current.sessionId !== record.sessionId) throw new WorkspaceLockError("workspace lock is no longer owned by this runtime", lockPath);
				},
				async release() {
					if (released) return;
					released = true;
					try {
						if ((await readLock(lockPath)).token !== record.token) throw new WorkspaceLockError("refusing to release a lock now owned by another runtime", lockPath);
						await unlink(lockPath);
					} catch (error) {
						if (error.code !== "ENOENT") throw error;
					} finally {
						if (ownedInProcess.get(canonical)?.token === record.token) ownedInProcess.delete(canonical);
					}
				}
			};
		} catch (error) {
			if (created) try {
				await unlink(lockPath);
			} catch (cleanupError) {
				if (cleanupError.code !== "ENOENT") throw new WorkspaceLockError("failed to clean up an incomplete lock", lockPath, { cause: cleanupError });
			}
			if (error.code !== "EEXIST") throw error;
		}
		let owner;
		try {
			owner = await readLock(lockPath);
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw error;
		}
		if (owner.workspace !== canonical) throw new WorkspaceLockError("lock workspace metadata does not match the canonical workspace", lockPath);
		if (isLockOwnerAlive(owner)) throw new WorkspaceBusyError(owner);
		if (!await recoverStaleOwner(canonical, lockPath, owner)) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
	}
	throw new WorkspaceLockError("unable to acquire lock after stale-owner recovery races", lockPath);
}
//#endregion
//#region src/permissions.ts
const FILE_TOOLS = /* @__PURE__ */ new Set([
	"read",
	"write",
	"edit",
	"glob",
	"grep"
]);
const READ_ONLY_TOOLS = [
	"read",
	"glob",
	"grep"
];
const READ_WRITE_TOOLS = [
	"read",
	"write",
	"edit",
	"glob",
	"grep"
];
/** AlphaSolve main permits orchestrator Write/Edit only for per-directory indexes. */
const ORCHESTRATOR_INDEX_PATH_PATTERN = String.raw`^verified_propositions(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*/index\.md$`;
const ORCHESTRATOR_INDEX_RELATIVE_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*index\.md$/;
/** Exact names known to provide process, code, generic delegation, or network access. */
const FORBIDDEN_ROLE_TOOLS = /* @__PURE__ */ new Set([
	"bash",
	"shell",
	"exec",
	"run_code",
	"subagent",
	"spawn_agent",
	"send_message",
	"task",
	"task_output",
	"task_kill",
	"web",
	"web_search",
	"web_fetch",
	"browser"
]);
const FORBIDDEN_TOOL_FAMILY = /^(?:bash|shell|terminal|exec(?:ute|[_-]command)?|run[_-]?code|web|browser)(?:$|[_-])/i;
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmptyPath(value, label) {
	if (value.length === 0) throw new TypeError(`${label} must not be empty`);
	return value;
}
function absoluteFrom(root, candidate) {
	return path.resolve(root, candidate);
}
function normalizeRule(cwd, rule) {
	const root = path.isAbsolute(rule.root) ? path.normalize(rule.root) : absoluteFrom(cwd, rule.root);
	return Object.freeze({
		...rule,
		root,
		access: Object.freeze([...rule.access]),
		effect: rule.effect ?? "allow",
		...rule.relativePattern === void 0 ? {} : { relativePattern: new RegExp(rule.relativePattern.source, rule.relativePattern.flags) }
	});
}
function fileRule(root, access, effect = "allow") {
	return {
		root,
		kind: "file",
		access,
		effect
	};
}
function directoryRule(root, access, effect = "allow", relativePattern) {
	return {
		root,
		kind: "directory",
		access,
		effect,
		...relativePattern === void 0 ? {} : { relativePattern }
	};
}
function requireScopePath(value, role, field) {
	if (value === void 0 || value.length === 0) throw new TypeError(`role "${role}" requires ${String(field)}`);
	return value;
}
function resolveScopePath(cwd, value) {
	return path.resolve(path.isAbsolute(value) ? value : path.join(cwd, value));
}
/**
* Materialize the filesystem/tool policy for one fresh role agent.
*
* Auxiliary roles intentionally receive no ambient workspace access: their
* caller must pass the roots which are safe for that particular delegation.
*/
function createRolePolicy(role, scope) {
	const cwd = path.resolve(nonEmptyPath(scope.workspace, "workspace"));
	const knowledge = path.resolve(scope.knowledgeDirectory ?? path.join(cwd, "knowledge"));
	const verified = path.resolve(scope.verifiedDirectory ?? path.join(cwd, "verified_propositions"));
	const problem = path.join(cwd, "problem.md");
	const hint = path.join(cwd, "hint.md");
	const extraTools = scope.extraAllowedTools ?? [];
	let standardTools;
	let rules;
	switch (role) {
		case "orchestrator":
			standardTools = READ_WRITE_TOOLS;
			rules = [
				fileRule(problem, ["read"]),
				fileRule(hint, ["read"]),
				fileRule(path.join(cwd, "solution.md"), ["read"]),
				directoryRule(knowledge, ["read"]),
				directoryRule(verified, ["read"]),
				directoryRule(verified, ["write"], "allow", ORCHESTRATOR_INDEX_RELATIVE_PATTERN)
			];
			break;
		case "generator": {
			const worker = resolveScopePath(cwd, requireScopePath(scope.workerDirectory, role, "workerDirectory"));
			const proposition = resolveScopePath(cwd, requireScopePath(scope.propositionFile, role, "propositionFile"));
			standardTools = READ_WRITE_TOOLS;
			rules = [
				fileRule(problem, ["read"]),
				fileRule(hint, ["read"]),
				directoryRule(knowledge, ["read"]),
				directoryRule(verified, ["read"]),
				directoryRule(worker, ["read"]),
				fileRule(proposition, ["read", "write"])
			];
			break;
		}
		case "verifier":
		case "verifier_citation": {
			const proposition = resolveScopePath(cwd, requireScopePath(scope.propositionFile, role, "propositionFile"));
			standardTools = READ_ONLY_TOOLS;
			rules = [
				fileRule(proposition, ["read"]),
				directoryRule(verified, ["read"]),
				...role === "verifier_citation" ? [] : [directoryRule(knowledge, ["read"])]
			];
			break;
		}
		case "reviser": {
			const proposition = resolveScopePath(cwd, requireScopePath(scope.propositionFile, role, "propositionFile"));
			standardTools = READ_WRITE_TOOLS;
			rules = [
				directoryRule(knowledge, ["read"]),
				directoryRule(verified, ["read"]),
				fileRule(proposition, ["read", "write"])
			];
			break;
		}
		case "theorem_checker": {
			const theoremView = resolveScopePath(cwd, requireScopePath(scope.theoremViewDirectory, role, "theoremViewDirectory"));
			standardTools = READ_ONLY_TOOLS;
			rules = [directoryRule(path.join(theoremView, "verified_propositions"), ["read"])];
			break;
		}
		case "curator":
			standardTools = READ_WRITE_TOOLS;
			rules = [directoryRule(knowledge, ["read", "write"]), directoryRule(path.join(knowledge, "references"), ["write"], "deny")];
			break;
		case "curator_helper":
			standardTools = READ_ONLY_TOOLS;
			rules = [directoryRule(knowledge, ["read"])];
			break;
		case "research_reviewer":
			standardTools = READ_ONLY_TOOLS;
			rules = [
				fileRule(problem, ["read"]),
				directoryRule(knowledge, ["read"]),
				directoryRule(verified, ["read"]),
				...(scope.delegatedReadRoots ?? []).map((root) => directoryRule(resolveScopePath(cwd, root), ["read"]))
			];
			break;
		case "compute":
		case "numerical_experiment":
		case "reasoning":
			standardTools = READ_ONLY_TOOLS;
			rules = (scope.delegatedReadRoots ?? []).map((root) => directoryRule(resolveScopePath(cwd, root), ["read"]));
	}
	for (const name of extraTools) if (role !== "orchestrator" && isForbiddenRoleTool(name)) throw new TypeError(`role "${role}" cannot allow forbidden tool "${name}"`);
	return Object.freeze({
		role,
		cwd,
		allowedTools: /* @__PURE__ */ new Set([...standardTools, ...extraTools]),
		paths: Object.freeze(rules.map((rule) => normalizeRule(cwd, rule)))
	});
}
/** Treat both POSIX and Windows path syntax as path syntax on every platform. */
function normalizeUserPath(candidate) {
	if (candidate.includes("\0")) throw new TypeError("path must not contain NUL bytes");
	if (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || /^[A-Za-z]:/.test(candidate)) throw new TypeError("absolute paths are not allowed");
	const segments = candidate.replaceAll("\\", "/").split("/");
	if (segments.includes("..")) throw new TypeError("parent path segments (..) are not allowed");
	return segments.join(path.sep);
}
function isWithin(candidate, root, kind) {
	const relative = path.relative(root, candidate);
	if (kind === "file") return relative === "";
	return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function applicableRules(policy, candidate, access) {
	let allowed;
	for (const rule of policy.paths) {
		if (!rule.access.includes(access) || !matchesPathRule(candidate, rule)) continue;
		if ((rule.effect ?? "allow") === "deny") return { denied: rule };
		allowed ??= rule;
	}
	return allowed === void 0 ? {} : { allowed };
}
function matchesPathRule(candidate, rule) {
	if (!isWithin(candidate, rule.root, rule.kind)) return false;
	if (rule.relativePattern === void 0) return true;
	const relative = path.relative(rule.root, candidate).split(path.sep).join("/");
	rule.relativePattern.lastIndex = 0;
	return rule.relativePattern.test(relative);
}
/** Extract the standard DSH filesystem path without interpreting helper tools. */
function toolPathRequest(execution) {
	if (!FILE_TOOLS.has(execution.name)) return void 0;
	if (!isRecord(execution.arguments)) throw new TypeError(`tool "${execution.name}" arguments must be an object`);
	if (execution.name === "write" || execution.name === "edit") {
		if ("sandbox_permissions" in execution.arguments || "justification" in execution.arguments) throw new TypeError(`tool "${execution.name}" cannot request sandbox escalation`);
	}
	const field = execution.name === "glob" || execution.name === "grep" ? "path" : "file_path";
	const raw = execution.arguments[field];
	const requested = raw === void 0 && field === "path" ? "." : raw;
	if (typeof requested !== "string" || requested.length === 0) throw new TypeError(`tool "${execution.name}" requires a non-empty string ${field}`);
	return {
		path: requested,
		access: execution.name === "write" || execution.name === "edit" ? "write" : "read"
	};
}
/** Validate a tool path without touching the filesystem; suitable for tools.guard(). */
function assertLexicalPathAccess(policy, requestedPath, access) {
	const normalized = normalizeUserPath(requestedPath);
	const lexicalPath = absoluteFrom(policy.cwd, normalized);
	const match = applicableRules(policy, lexicalPath, access);
	if (match.denied !== void 0) throw new Error(`${access} access is denied for "${requestedPath}"`);
	if (match.allowed === void 0) throw new Error(`${access} access is outside the ${policy.role} role boundary: "${requestedPath}"`);
	return lexicalPath;
}
/**
* Resolve an existing path, or the nearest existing ancestor of a create target.
* This detects a symlink in every existing component without requiring the leaf
* to exist yet.
*/
async function canonicalizePotentialPath(candidate) {
	const missing = [];
	let cursor = path.resolve(candidate);
	while (true) try {
		const canonicalAncestor = await realpath(cursor);
		return path.resolve(canonicalAncestor, ...missing.reverse());
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") throw error;
		try {
			if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`path contains a broken symbolic link: "${cursor}"`);
		} catch (lstatError) {
			if (!isRecord(lstatError) || lstatError.code !== "ENOENT") throw lstatError;
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) throw error;
		missing.push(path.basename(cursor));
		cursor = parent;
	}
}
/** Resolve symlinks in both the requested path and grants, then re-check access. */
async function assertCanonicalContainment(policy, requestedPath, access) {
	const lexicalPath = assertLexicalPathAccess(policy, requestedPath, access);
	const canonicalPath = await canonicalizePotentialPath(lexicalPath);
	let allowed;
	for (const lexicalRule of policy.paths) {
		if (!lexicalRule.access.includes(access)) continue;
		const canonicalRoot = await canonicalizePotentialPath(lexicalRule.root);
		const canonicalRule = {
			...lexicalRule,
			root: canonicalRoot
		};
		if (!matchesPathRule(canonicalPath, canonicalRule)) continue;
		if ((lexicalRule.effect ?? "allow") === "deny") throw new Error(`${access} access resolves into a denied path: "${requestedPath}"`);
		allowed ??= canonicalRule;
	}
	if (allowed === void 0) throw new Error(`${access} access escapes the ${policy.role} role boundary through a symbolic link: "${requestedPath}"`);
	return {
		requestedPath,
		lexicalPath,
		canonicalPath,
		matchedRule: allowed
	};
}
function isForbiddenRoleTool(name) {
	return FORBIDDEN_ROLE_TOOLS.has(name) || FORBIDDEN_TOOL_FAMILY.test(name);
}
/** Final synchronous policy boundary which later waterfall listeners cannot override. */
function createLexicalToolGuard(policy) {
	return (execution) => {
		if (policy.role !== "orchestrator" && isForbiddenRoleTool(execution.name)) return `tool "${execution.name}" is forbidden for AlphaSolve role agents`;
		if (!policy.allowedTools.has(execution.name)) return `tool "${execution.name}" is not allowed for AlphaSolve role "${policy.role}"`;
		try {
			const request = toolPathRequest(execution);
			if (request !== void 0) assertLexicalPathAccess(policy, request.path, request.access);
			return;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	};
}
/**
* Install both lexical and canonical checks into one Agent scope.
*
* Custom helper tools remain responsible for calling
* assertCanonicalContainment for each path they accept; only the five standard
* DSH filesystem tools have a common argument contract here.
*/
function installRolePermissionBoundary(ctx, policy) {
	const disposeGuard = ctx.tools.guard(createLexicalToolGuard(policy));
	const disposeCanonical = ctx.on("tools/pre-execute", async (execution, next) => {
		try {
			const request = toolPathRequest(execution);
			if (request !== void 0) {
				if (execution.signal.aborted) return {
					kind: "deny",
					reason: "tool call was cancelled"
				};
				await assertCanonicalContainment(policy, request.path, request.access);
				if (execution.signal.aborted) return {
					kind: "deny",
					reason: "tool call was cancelled"
				};
			}
		} catch (error) {
			return {
				kind: "deny",
				reason: error instanceof Error ? error.message : String(error)
			};
		}
		return next();
	});
	return () => {
		disposeCanonical();
		disposeGuard();
	};
}
//#endregion
//#region src/project-tools.ts
/** Safe project-organization tools temporarily exposed to the AlphaSolve orchestrator. */
const KNOWLEDGE = "knowledge";
const REFERENCES = "knowledge/references";
const VERIFIED = "verified_propositions";
const PROTECTED_NAMES = /* @__PURE__ */ new Set(["index.md"]);
const PATH_SEGMENT = String.raw`[A-Za-z0-9][A-Za-z0-9._-]*`;
const VERIFIED_DIRECTORY_PATH_PATTERN = String.raw`^verified_propositions(?:/${PATH_SEGMENT})*/?$`;
const VERIFIED_SUBDIRECTORY_PATH_PATTERN = String.raw`^verified_propositions(?:/${PATH_SEGMENT})+/?$`;
const VERIFIED_MARKDOWN_PATH_PATTERN = String.raw`^verified_propositions/(?!index\.md$)(?!.*\/index\.md$)(?:${PATH_SEGMENT}/)*${PATH_SEGMENT}\.md$`;
const VERIFIED_RENAME_NAME_PATTERN = String.raw`^(?!index\.md$)${PATH_SEGMENT}$`;
const PROJECT_TOOL_NAMES = Object.freeze({
	mkdir: "alphasolve_mkdir",
	rename: "alphasolve_rename",
	move: "alphasolve_move"
});
/** A project-tool rejection whose message is safe to return to the orchestrator. */
var ProjectToolError = class extends Error {
	path;
	constructor(message, path, options) {
		super(path === void 0 ? message : `${message}: ${path}`, options);
		this.path = path;
		this.name = "ProjectToolError";
	}
};
function isMissing$1(error) {
	return error?.code === "ENOENT";
}
function isConflict(error) {
	const code = error?.code;
	return code === "EEXIST" || code === "ENOTEMPTY";
}
function decodeUtf8(bytes, file) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new ProjectToolError("verified Markdown is not valid UTF-8", file, { cause: error });
	}
}
function toRelative(root, absolute) {
	return path.relative(root, absolute).split(path.sep).join("/");
}
function scopeOf(relativePath) {
	if (relativePath === KNOWLEDGE || relativePath.startsWith(`${KNOWLEDGE}/`)) return "knowledge";
	if (relativePath === VERIFIED || relativePath.startsWith(`${VERIFIED}/`)) return "verified_propositions";
}
function protectedName(relativePath) {
	return PROTECTED_NAMES.has(path.posix.basename(relativePath));
}
function plainName(value, label) {
	if (value.length === 0 || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) throw new ProjectToolError(`${label} must be one plain name`, value);
	if (!new RegExp(VERIFIED_RENAME_NAME_PATTERN).test(value)) throw new ProjectToolError(`${label} is invalid or names protected index.md`, value);
	return value;
}
function withoutOptionalTrailingSlash(value) {
	if (!value.endsWith("/") && !value.endsWith("\\")) return value;
	return value.slice(0, -1);
}
function normalizedMatchingPath(value, pattern, label) {
	const normalized = normalizeRelativePath(withoutOptionalTrailingSlash(value));
	if (!new RegExp(pattern).test(normalized)) throw new ProjectToolError(`${label} must stay inside verified_propositions and use AlphaSolve path names`, value);
	return normalized;
}
function mapMovedPath(source, target, candidate) {
	if (candidate === source) return target;
	if (!isContained(source, candidate)) return candidate;
	return path.join(target, path.relative(source, candidate));
}
function refLabel(relativePath) {
	const prefix = `${VERIFIED}/`;
	if (!relativePath.startsWith(prefix) || !relativePath.toLowerCase().endsWith(".md")) return void 0;
	return relativePath.slice(prefix.length, -3);
}
function rewriteReferences(content, replacements) {
	let next = content;
	for (const [oldLabel, newReference] of [...replacements.entries()].sort((left, right) => right[0].length - left[0].length)) next = next.replaceAll(`\\ref{${oldLabel}}`, newReference);
	return next;
}
/**
* Orchestrator-only organization operations.
*
* The class intentionally has no general write/delete-file primitive. A
* caller can organize existing research, but cannot promote a knowledge note
* into verified_propositions or fabricate a new verified proposition.
*/
var AlphaSolveProjectTools = class AlphaSolveProjectTools {
	workspaceRoot;
	knowledgeRoot;
	referencesRoot;
	verifiedRoot;
	writeText;
	constructor(workspaceRoot, knowledgeRoot, referencesRoot, verifiedRoot, writeText) {
		this.workspaceRoot = workspaceRoot;
		this.knowledgeRoot = knowledgeRoot;
		this.referencesRoot = referencesRoot;
		this.verifiedRoot = verifiedRoot;
		this.writeText = writeText;
	}
	static async create(workspaceRoot, options = {}) {
		const root = await canonicalWorkspace(workspaceRoot);
		const knowledgePath = path.join(root, KNOWLEDGE);
		const referencesPath = path.join(root, REFERENCES);
		const verifiedPath = path.join(root, VERIFIED);
		try {
			if ((await Promise.all([
				lstat(knowledgePath),
				lstat(referencesPath),
				lstat(verifiedPath)
			])).some((info) => !info.isDirectory() || info.isSymbolicLink())) throw new ProjectToolError("project tool roots must be ordinary directories");
			const [knowledgeRoot, referencesRoot, verifiedRoot] = await Promise.all([
				realpath(knowledgePath),
				realpath(referencesPath),
				realpath(verifiedPath)
			]);
			if (!isContained(root, knowledgeRoot) || !isContained(knowledgeRoot, referencesRoot) || !isContained(root, verifiedRoot)) throw new ProjectToolError("project tool root escapes the workspace");
			return new AlphaSolveProjectTools(root, knowledgeRoot, referencesRoot, verifiedRoot, options.writeText ?? atomicWriteText);
		} catch (error) {
			if (error instanceof ProjectToolError) throw error;
			throw new ProjectToolError("unable to initialize AlphaSolve project tools", void 0, { cause: error });
		}
	}
	async nearestExisting(target) {
		let cursor = target;
		for (;;) {
			try {
				await lstat(cursor);
				return cursor;
			} catch (error) {
				if (!isMissing$1(error)) throw error;
			}
			const parent = path.dirname(cursor);
			if (parent === cursor) throw new ProjectToolError("path has no existing ancestor", target);
			cursor = parent;
		}
	}
	/** Reject every symlink component; this closes both escape and alias races. */
	async assertNoSymlinkComponents(scopeRoot, target) {
		const relative = path.relative(scopeRoot, target);
		if (relative === "") return;
		let cursor = scopeRoot;
		for (const component of relative.split(path.sep)) {
			cursor = path.join(cursor, component);
			try {
				if ((await lstat(cursor)).isSymbolicLink()) throw new ProjectToolError("symbolic links are not allowed in project mutations", toRelative(this.workspaceRoot, cursor));
			} catch (error) {
				if (isMissing$1(error)) return;
				throw error;
			}
		}
	}
	async resolve(input, mustExist) {
		let relativePath;
		try {
			relativePath = normalizeRelativePath(input);
		} catch (error) {
			if (error instanceof WorkspaceError) throw new ProjectToolError(error.message, void 0, { cause: error });
			throw error;
		}
		const scope = scopeOf(relativePath);
		if (scope === void 0) throw new ProjectToolError("project mutations are restricted to knowledge/ and verified_propositions/", input);
		const scopeRoot = scope === "knowledge" ? this.knowledgeRoot : this.verifiedRoot;
		const absolute = path.resolve(this.workspaceRoot, ...relativePath.split("/"));
		if (!isContained(scopeRoot, absolute)) throw new ProjectToolError("path escapes its project root", input);
		await this.assertNoSymlinkComponents(scopeRoot, absolute);
		let exists = true;
		let canonicalAnchor;
		try {
			canonicalAnchor = await realpath(absolute);
		} catch (error) {
			if (!isMissing$1(error)) throw new ProjectToolError("unable to resolve project path", input, { cause: error });
			exists = false;
			if (mustExist) throw new ProjectToolError("path does not exist", input, { cause: error });
			canonicalAnchor = await realpath(await this.nearestExisting(absolute));
		}
		if (!isContained(scopeRoot, canonicalAnchor)) throw new ProjectToolError("path resolves outside its project root", input);
		const inReferences = scope === "knowledge" && (relativePath === REFERENCES || relativePath.startsWith(`${REFERENCES}/`) || isContained(this.referencesRoot, canonicalAnchor));
		return {
			requested: input,
			relative: relativePath,
			absolute,
			scope,
			scopeRoot,
			exists,
			canonicalAnchor,
			inReferences
		};
	}
	rejectReferences(target) {
		if (target.inReferences) throw new ProjectToolError("knowledge/references is read-only project material", target.requested);
	}
	rejectRoot(target, operation) {
		if (target.absolute === target.scopeRoot) throw new ProjectToolError(`${operation} cannot target a project root`, target.requested);
	}
	rejectProtected(target) {
		if (protectedName(target.relative)) throw new ProjectToolError("protected index/state files cannot be moved or renamed", target.requested);
	}
	async ensureDirectory(relativePath) {
		const normalized = normalizeRelativePath(relativePath);
		if (scopeOf(normalized) === void 0) throw new ProjectToolError("directory is outside project roots", relativePath);
		const components = normalized.split("/");
		let current = components[0];
		if (current === void 0) throw new ProjectToolError("invalid directory path", relativePath);
		let resolved = await this.resolve(current, true);
		for (const component of components.slice(1)) {
			current = `${current}/${component}`;
			resolved = await this.resolve(current, false);
			this.rejectReferences(resolved);
			if (resolved.exists) {
				if (!(await stat(resolved.absolute)).isDirectory()) throw new ProjectToolError("path component is not a directory", current);
				continue;
			}
			try {
				await mkdir(resolved.absolute, { mode: 448 });
			} catch (error) {
				if (!isConflict(error)) throw error;
			}
			resolved = await this.resolve(current, true);
			if (!(await stat(resolved.absolute)).isDirectory()) throw new ProjectToolError("path component is not a directory", current);
		}
		return resolved;
	}
	/** Recursively create only the requested directory chain below one allowed root. */
	async mkdir(relativePath) {
		const normalized = normalizedMatchingPath(relativePath, VERIFIED_SUBDIRECTORY_PATH_PATTERN, "mkdir path");
		const target = await this.resolve(normalized, false);
		this.rejectReferences(target);
		this.rejectRoot(target, "mkdir");
		return { path: (await this.ensureDirectory(target.relative)).relative };
	}
	async walkMarkdown(directory) {
		const result = [];
		const pending = [directory];
		while (pending.length > 0) {
			const current = pending.pop();
			if (current === void 0) break;
			const entries = await readdir(current, { withFileTypes: true });
			entries.sort((left, right) => left.name.localeCompare(right.name));
			for (const entry of entries) {
				const absolute = path.join(current, entry.name);
				if (entry.isSymbolicLink()) {
					const canonical = await realpath(absolute);
					if (!isContained(this.verifiedRoot, canonical)) throw new ProjectToolError("symbolic link escapes verified_propositions", toRelative(this.workspaceRoot, absolute));
					throw new ProjectToolError("symbolic links are not supported while updating proposition references", toRelative(this.workspaceRoot, absolute));
				}
				if (entry.isDirectory()) pending.push(absolute);
				else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) result.push({
					absolute,
					relative: toRelative(this.workspaceRoot, absolute),
					content: decodeUtf8(await readFile(absolute), toRelative(this.workspaceRoot, absolute))
				});
			}
		}
		return result.sort((left, right) => left.relative.localeCompare(right.relative));
	}
	buildReferenceUpdates(source, target, snapshots) {
		const replacements = /* @__PURE__ */ new Map();
		for (const snapshot of snapshots) {
			if (!isContained(source.absolute, snapshot.absolute)) continue;
			const afterAbsolute = mapMovedPath(source.absolute, target.absolute, snapshot.absolute);
			const oldLabel = refLabel(snapshot.relative);
			const newLabel = refLabel(toRelative(this.workspaceRoot, afterAbsolute));
			if (oldLabel === void 0 || newLabel === void 0 || oldLabel === newLabel) continue;
			const newReference = `\\ref{${newLabel.replaceAll("/", "\\")}}`;
			replacements.set(oldLabel, newReference);
			replacements.set(oldLabel.replaceAll("/", "\\"), newReference);
		}
		if (replacements.size === 0) return [];
		return snapshots.flatMap((snapshot) => {
			const nextContent = rewriteReferences(snapshot.content, replacements);
			if (nextContent === snapshot.content) return [];
			return [{
				...snapshot,
				afterAbsolute: mapMovedPath(source.absolute, target.absolute, snapshot.absolute),
				nextContent
			}];
		});
	}
	async rollbackMove(source, target, appliedUpdates) {
		const failures = [];
		for (const update of [...appliedUpdates].reverse()) try {
			await withFileLock(update.afterAbsolute, async () => {
				if (decodeUtf8(await readFile(update.afterAbsolute), toRelative(this.workspaceRoot, update.afterAbsolute)) !== update.nextContent) throw new ProjectToolError("cannot roll back a reference file changed by another writer", toRelative(this.workspaceRoot, update.afterAbsolute));
				await this.writeText(update.afterAbsolute, update.content);
			});
		} catch (error) {
			failures.push(`restore ${toRelative(this.workspaceRoot, update.afterAbsolute)}: ${String(error)}`);
		}
		try {
			await rename(target.absolute, source.absolute);
		} catch (error) {
			failures.push(`restore path ${target.relative} -> ${source.relative}: ${String(error)}`);
		}
		return failures;
	}
	async writeReferenceUpdate(update) {
		await withFileLock(update.afterAbsolute, async () => {
			if (decodeUtf8(await readFile(update.afterAbsolute), toRelative(this.workspaceRoot, update.afterAbsolute)) !== update.content) throw new ProjectToolError("verified Markdown changed while preparing the move; retry after rereading the project", toRelative(this.workspaceRoot, update.afterAbsolute));
			await this.writeText(update.afterAbsolute, update.nextContent);
		});
	}
	/**
	* Move or rename an existing file/directory to an explicit new path.
	* Cross-root moves are forbidden, so knowledge can never masquerade as a
	* verified proposition.
	*/
	async move(sourcePath, targetPath) {
		const source = await this.resolve(sourcePath, true);
		const target = await this.resolve(targetPath, false);
		this.rejectReferences(source);
		this.rejectReferences(target);
		this.rejectRoot(source, "move");
		this.rejectRoot(target, "move");
		this.rejectProtected(source);
		this.rejectProtected(target);
		if (source.scope !== target.scope) throw new ProjectToolError("moves cannot cross knowledge and verified_propositions boundaries", targetPath);
		if (source.absolute === target.absolute) return {
			oldPath: source.relative,
			path: target.relative,
			updatedReferenceFiles: 0
		};
		if (isContained(source.absolute, target.absolute)) throw new ProjectToolError("cannot move a directory into its own subtree", targetPath);
		const sourceInfo = await lstat(source.absolute);
		if (!sourceInfo.isFile() && !sourceInfo.isDirectory()) throw new ProjectToolError("move source must be an ordinary file or directory", sourcePath);
		if (sourceInfo.isFile() && path.extname(source.absolute).toLowerCase() !== ".md") throw new ProjectToolError("project move only supports Markdown files", sourcePath);
		if (sourceInfo.isFile() && path.extname(target.absolute).toLowerCase() !== ".md") throw new ProjectToolError("renaming a Markdown file must preserve the .md extension", targetPath);
		if (target.exists) throw new ProjectToolError("move target already exists", targetPath);
		const parent = await this.resolve(toRelative(this.workspaceRoot, path.dirname(target.absolute)), true);
		this.rejectReferences(parent);
		if (!(await stat(parent.absolute)).isDirectory()) throw new ProjectToolError("move target parent is not a directory", targetPath);
		let updates = [];
		if (source.scope === "verified_propositions") {
			const snapshots = await this.walkMarkdown(this.verifiedRoot);
			updates = this.buildReferenceUpdates(source, target, snapshots);
		}
		try {
			await rename(source.absolute, target.absolute);
		} catch (error) {
			if (isConflict(error)) throw new ProjectToolError("move target already exists", targetPath, { cause: error });
			throw new ProjectToolError("unable to move project path", sourcePath, { cause: error });
		}
		const appliedUpdates = [];
		try {
			for (const update of updates) {
				await this.writeReferenceUpdate(update);
				appliedUpdates.push(update);
			}
		} catch (error) {
			const rollbackFailures = await this.rollbackMove(source, target, appliedUpdates);
			if (rollbackFailures.length > 0) throw new ProjectToolError(`reference update failed and rollback was incomplete; workspace is fail-closed (${rollbackFailures.join("; ")})`, sourcePath, { cause: error });
			throw new ProjectToolError("reference update failed; move was rolled back", sourcePath, { cause: error });
		}
		return {
			oldPath: source.relative,
			path: target.relative,
			updatedReferenceFiles: updates.length
		};
	}
	/** AlphaSolve-compatible in-place rename convenience. */
	async rename(directory, oldName, newName) {
		const oldPlain = plainName(oldName, "oldName");
		const newPlain = plainName(newName, "newName");
		const normalizedDirectory = normalizedMatchingPath(directory, VERIFIED_DIRECTORY_PATH_PATTERN, "rename directory");
		return this.move(`${normalizedDirectory}/${oldPlain}`, `${normalizedDirectory}/${newPlain}`);
	}
	/** AlphaSolve-compatible move which preserves the source file name. */
	async moveInto(sourcePath, destinationDirectory) {
		const normalizedSource = normalizedMatchingPath(sourcePath, VERIFIED_MARKDOWN_PATH_PATTERN, "move path");
		const normalizedDestination = normalizedMatchingPath(destinationDirectory, VERIFIED_DIRECTORY_PATH_PATTERN, "move destination");
		const source = await this.resolve(normalizedSource, true);
		const destination = await this.resolve(normalizedDestination, true);
		const sourceInfo = await lstat(source.absolute);
		if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new ProjectToolError("move path must be one ordinary verified Markdown file", sourcePath);
		if (!(await stat(destination.absolute)).isDirectory()) throw new ProjectToolError("move destination is not a directory", destinationDirectory);
		return this.move(source.relative, `${destination.relative}/${path.basename(source.absolute)}`);
	}
};
async function createProjectTools(workspaceRoot, options = {}) {
	return AlphaSolveProjectTools.create(workspaceRoot, options);
}
//#endregion
//#region src/parsers.ts
/**
* Parse the output of AlphaSolve's independent verifier-verdict judge.
*
* The original implementation is intentionally fail-closed: an empty or
* ambiguous answer, including one that contains both words, is a failure.
*/
function parseVerifierVerdict(text) {
	const clean = (text ?? "").trim().toLowerCase();
	return clean.includes("pass") && !clean.includes("fail") ? "pass" : "fail";
}
/** Return true only when the theorem-checker answer contains AlphaSolve's yes marker. */
function solvesOriginalProblem(text) {
	return /solves\s+original\s+problem\s*:\s*yes\b/i.test(text ?? "");
}
/**
* Extract the Statement section for the compact worker-completion summary.
*
* This preserves the slightly unusual leading newline of AlphaSolve main so
* existing result rendering does not silently change during the port.
*/
function extractStatement(text, limit = 800) {
	const markerStart = text.toLowerCase().indexOf("## statement");
	if (markerStart === -1) return `\n${text.slice(0, limit)}`;
	const contentStart = text.indexOf("\n", markerStart);
	if (contentStart === -1) return `\n${text.slice(0, limit)}`;
	const nextHeading = text.indexOf("\n## ", contentStart + 1);
	return `\n${(nextHeading === -1 ? text.slice(contentStart).trim() : text.slice(contentStart, nextHeading).trim()).slice(0, limit)}`;
}
/**
* Sanitize the filename-only answer from AlphaSolve's proposition namer.
* The caller may supply a deterministic fallback id for tests and recovery.
*/
function parsePropositionFilename(text, fallbackId = randomUUID().replaceAll("-", "").slice(0, 8)) {
	let name = (text ?? "").trim().toLowerCase();
	name = name.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
	if (name.length > 0 && name.length <= 140) return `${name}.md`;
	return `proposition-${fallbackId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32) || "unknown"}.md`;
}
/**
* Detect likely author/year or title/year parentheticals for the citation
* verifier. This is only a triage hint; it never accepts or rejects a proof.
*/
function findExternalReferenceParentheticals(text) {
	const yearPattern = /(?<![A-Za-z0-9])(?:1[7-9]\d{2}|20\d{2}|2100)(?![A-Za-z0-9])/g;
	const results = [];
	const seen = /* @__PURE__ */ new Set();
	for (const match of text.matchAll(yearPattern)) {
		const yearStart = match.index;
		const yearEnd = yearStart + match[0].length;
		const lowerBound = Math.max(0, yearStart - 50);
		const left = text.lastIndexOf("(", yearStart - 1);
		if (left < lowerBound) continue;
		let depth = 0;
		let right = -1;
		for (let index = left; index < text.length; index += 1) if (text[index] === "(") depth += 1;
		else if (text[index] === ")") {
			depth -= 1;
			if (depth === 0) {
				right = index;
				break;
			}
			if (depth < 0) break;
		}
		if (right === -1 || right < yearEnd || right - yearEnd > 50) continue;
		const parenthetical = text.slice(left + 1, right).trim().split(/\s+/).join(" ");
		if (!parenthetical) continue;
		const lineNumber = text.slice(0, left).split("\n").length;
		const key = `${lineNumber}\u0000${parenthetical}`;
		if (seen.has(key)) continue;
		seen.add(key);
		results.push({
			lineNumber,
			parenthetical
		});
	}
	return results;
}
//#endregion
//#region src/prompts.ts
function prompt(...lines) {
	return lines.join("\n").trim();
}
const VERIFIER_PROFILE_ORDER = [
	"verifier_format_references",
	"verifier_citation",
	"verifier_failure_modes",
	"verifier_stepwise",
	"verifier_premise_chain"
];
function loadPromptAsset(name) {
	return readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8").trim();
}
const REVIEW_VERDICT_JUDGE_PROMPT = loadPromptAsset("review_verdict_judge");
const GENERATOR_PROMPT = loadPromptAsset("generator");
const REVISER_PROMPT = loadPromptAsset("reviser");
const THEOREM_CHECKER_PROMPT = loadPromptAsset("theorem_checker");
const VERIFIER_PROMPT = loadPromptAsset("verifier");
const VERIFIER_FORMAT_REFERENCES_PROMPT = loadPromptAsset("verifier_format_references");
const VERIFIER_CITATION_PROMPT = loadPromptAsset("verifier_citation");
const VERIFIER_FAILURE_MODES_PROMPT = loadPromptAsset("verifier_failure_modes");
const VERIFIER_STEPWISE_PROMPT = loadPromptAsset("verifier_stepwise");
const VERIFIER_PREMISE_CHAIN_PROMPT = loadPromptAsset("verifier_premise_chain");
const COMPUTE_SUBAGENT_PROMPT = loadPromptAsset("compute");
const NUMERICAL_EXPERIMENT_SUBAGENT_PROMPT = loadPromptAsset("numerical_experiment");
const REASONING_SUBAGENT_PROMPT = loadPromptAsset("reasoning");
const RESEARCH_REVIEWER_PROMPT = loadPromptAsset("research_reviewer");
const CURATOR_PROMPT = loadPromptAsset("curator");
const ORCHESTRATOR_PROMPT = loadPromptAsset("orchestrator");
const ROLE_PROMPTS = Object.freeze({
	orchestrator: ORCHESTRATOR_PROMPT,
	generator: GENERATOR_PROMPT,
	reviser: REVISER_PROMPT,
	theorem_checker: THEOREM_CHECKER_PROMPT,
	verifier: VERIFIER_PROMPT,
	verifier_format_references: VERIFIER_FORMAT_REFERENCES_PROMPT,
	verifier_citation: VERIFIER_CITATION_PROMPT,
	verifier_failure_modes: VERIFIER_FAILURE_MODES_PROMPT,
	verifier_stepwise: VERIFIER_STEPWISE_PROMPT,
	verifier_premise_chain: VERIFIER_PREMISE_CHAIN_PROMPT,
	review_verdict_judge: REVIEW_VERDICT_JUDGE_PROMPT,
	compute: COMPUTE_SUBAGENT_PROMPT,
	numerical_experiment: NUMERICAL_EXPERIMENT_SUBAGENT_PROMPT,
	reasoning: REASONING_SUBAGENT_PROMPT,
	research_reviewer: RESEARCH_REVIEWER_PROMPT,
	curator: CURATOR_PROMPT
});
/** AlphaSolve main turn budgets. DSH model routes are resolved separately. */
const ROLE_MAX_TURNS = Object.freeze({
	orchestrator: 80,
	generator: 80,
	reviser: 80,
	theorem_checker: 60,
	verifier: 80,
	verifier_format_references: 80,
	verifier_citation: 40,
	verifier_failure_modes: 80,
	verifier_stepwise: 80,
	verifier_premise_chain: 80,
	review_verdict_judge: 80,
	compute: 80,
	numerical_experiment: 80,
	reasoning: 80,
	research_reviewer: 100,
	curator: 80
});
/** Role-scoped helper types; an empty tuple means the Agent tool must be absent. */
const ROLE_SUBAGENTS = Object.freeze({
	generator: [
		"compute",
		"numerical_experiment",
		"research_reviewer",
		"reasoning"
	],
	verifier_format_references: [],
	verifier_citation: ["reasoning"],
	verifier_failure_modes: [
		"compute",
		"numerical_experiment",
		"reasoning"
	],
	verifier_stepwise: [
		"compute",
		"numerical_experiment",
		"reasoning"
	],
	verifier_premise_chain: [
		"compute",
		"numerical_experiment",
		"reasoning"
	],
	reviser: [
		"compute",
		"numerical_experiment",
		"reasoning"
	],
	theorem_checker: [],
	curator: ["compute", "reasoning"],
	compute: [],
	numerical_experiment: [],
	reasoning: [],
	research_reviewer: [],
	review_verdict_judge: []
});
function loadRolePrompt(role) {
	return ROLE_PROMPTS[role];
}
function buildGeneratorTask(input) {
	const sections = ["# Problem", input.problem];
	if (input.hint) sections.push("# General Hint", input.hint);
	if (input.instruction) sections.push("# Task Guidance", input.instruction);
	sections.push("# Output", `Create \`proposition.md\` directly in your own directory \`${input.workerRelativePath}\`. It must contain exactly \`## Statement\` followed by \`## Proof\`, with no remarks or extra headings. The Statement must be pure mathematics, without a theorem-like label. Cite established propositions with \`\\ref{path-without-extension}\` relative to \`verified_propositions/\`, using backslashes between subdirectories.`);
	return sections.join("\n\n");
}
function buildVerifierTask(input) {
	const profile = input.profile.startsWith("verifier_") ? input.profile : `verifier_${input.profile}`;
	let instruction;
	if (profile === "verifier_format_references") instruction = "Perform the first format/reference-source gate. Check the exact two-section format, pure Statement, absence of remarks, and whether every external mathematical source is present under `knowledge/references/`. End with `Verdict: pass` or `Verdict: fail`.";
	else if (profile === "verifier_citation") {
		instruction = "Perform the citation/reference audit. Resolve every `\\ref{...}` under `verified_propositions/`, reject knowledge used as established mathematics, and check the hypotheses of every cited proposition with a bounded reasoning subagent. End with `Verdict: pass` or `Verdict: fail`.";
		const parentheticals = findExternalReferenceParentheticals(input.propositionText);
		if (parentheticals.length > 0) instruction += "\n\nPotential external paper/book citation parentheticals detected; inspect whether they are unsupported external dependencies:\n" + parentheticals.map(({ lineNumber, parenthetical }) => `- line ${lineNumber}: (${parenthetical})`).join("\n");
	} else instruction = "Write a rigorous review of the Statement and Proof under this verifier profile. Focus on correctness, completeness, hidden assumptions, and logical rigor; earlier profiles handle format and citations. End with `Verdict: pass` or `Verdict: fail`.";
	return prompt("# Verification Target", input.propositionPath, "", instruction, "", "Judge only defects in this candidate Statement or Proof under the assigned profile. Its failure to solve, advance, resemble, or mention the original problem is never a valid reason to fail.", "", `Verifier workflow: ${input.workflowIndex}`, `Independent verification attempt: ${input.attemptIndex} of ${input.attemptTotal}`, `Verifier config: ${profile}`);
}
function buildReviewVerdictTask(review, workflowIndex, attemptIndex) {
	return prompt("# Verifier Workflow", String(workflowIndex), "", "# Attempt", String(attemptIndex), "", "# Attempt Review", review, "", "Ignore criticism based only on failure to solve or advance the original problem. Such criticism is outside verifier scope.", "", "Return exactly either `pass` or `fail`.");
}
function buildReviserTask(propositionPath, review, workflowIndex) {
	return prompt("# Candidate Proposition File", propositionPath, "", "# Review", review, "", "Rewrite the same proposition Markdown file in place, addressing every candidate-local mathematical, logical, format, dependency, or citation issue.", "Ignore any criticism based only on failure to solve or advance the original problem, and never expand an auxiliary proposition into the original solution for that reason.", "", `Revision after verifier workflow: ${workflowIndex}`);
}
function buildTheoremCheckerTask(problem, verifiedPropositionPath) {
	return prompt("# Problem", problem, "", "# Newly Verified Proposition File", verifiedPropositionPath, "", "Assess this proposition against the original problem using the theorem-checker rules.");
}
function buildCuratorDigestTask(input) {
	const payload = input.callerContext ? {
		trace_kind: input.traceKind,
		caller_context: input.callerContext,
		subagent_trace: input.trace
	} : {
		trace_kind: input.traceKind,
		trace: input.trace
	};
	const commonErrors = input.finalVerifierReview ? "This is a verifier's final review. When useful, append up to three reusable error patterns to `knowledge/common-errors.md`, deduplicating and keeping at most 15 patterns." : "Do not modify `knowledge/common-errors.md`.";
	return prompt("# Trace Segment for Knowledge Base", "", "```json", JSON.stringify(payload, null, 2), "```", "", "Update `knowledge/` from this trace. Metadata is private triage context: never copy worker, role, round, attempt, source-label, or session identifiers into the wiki.", "Read `knowledge/index.md` first. Preserve reusable derivations, observations, failed routes, and open gaps; split oversized topics into focused folders with local indexes.", commonErrors, "Before finishing, ensure `knowledge/index.md` accurately routes the current entries.");
}
function buildCuratorHealthCheckTask(scanText = "") {
	return prompt("# Knowledge Base Health Check", "", "Read `knowledge/index.md` first, then make focused maintenance fixes.", "- Every index tracks only immediate child files and folders.", "- Ordinary pages over 250 lines should usually be split; keep `common-errors.md` compressed and at most 15 patterns.", "- Protect human material in `knowledge/references/`; never rewrite it, and split only by exact line ranges.", "- Check stale links, confusing names, redundant pages, missing local indexes, and untracked files.", "- Do not add new common-error patterns during a health check.", "- Never record pipeline identifiers or maintenance history.", scanText.trim() ? `\n\nProgram scan before curator:\n${scanText.trim()}\nUse this only as triage; inspect files before changing them.` : "");
}
const PROPOSITION_FILENAME_PROMPT_PREFIX = prompt("Read the following verified mathematical proposition and return a descriptive kebab-case filename", "(5-15 words, lowercase, hyphens only, no extension) that exactly captures its mathematical content.", "Return ONLY the filename, nothing else.");
function buildPropositionFilenameTask(propositionText) {
	return `${PROPOSITION_FILENAME_PROMPT_PREFIX}\n\n${propositionText.slice(0, 3e3)}`;
}
//#endregion
//#region src/calculator.ts
const CALCULATOR_TOOL_NAME = "alphasolve_calculate";
var ExpressionEvaluationError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.name = "ExpressionEvaluationError";
		this.code = code;
	}
};
const DEFAULT_LIMITS = Object.freeze({
	maxLength: 2e3,
	maxNodes: 512,
	maxSteps: 1024,
	maxDepth: 64
});
const NUMBER_PREFIX = /^(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/;
const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_CONTINUE = /[A-Za-z0-9_]/;
function fixedArity(arity, invoke) {
	return {
		minArgs: arity,
		maxArgs: arity,
		invoke: (args) => invoke(...args)
	};
}
function rangedArity(minArgs, maxArgs, invoke) {
	return {
		minArgs,
		maxArgs,
		invoke: (args) => invoke(...args)
	};
}
/** Deliberately finite whitelist: no random, callbacks, objects, or property access. */
const FUNCTIONS = Object.freeze({
	abs: fixedArity(1, Math.abs),
	acos: fixedArity(1, Math.acos),
	acosh: fixedArity(1, Math.acosh),
	asin: fixedArity(1, Math.asin),
	asinh: fixedArity(1, Math.asinh),
	atan: fixedArity(1, Math.atan),
	atanh: fixedArity(1, Math.atanh),
	atan2: fixedArity(2, Math.atan2),
	cbrt: fixedArity(1, Math.cbrt),
	ceil: fixedArity(1, Math.ceil),
	clamp: fixedArity(3, (value, lower, upper) => Math.min(Math.max(value, lower), upper)),
	cos: fixedArity(1, Math.cos),
	cosh: fixedArity(1, Math.cosh),
	exp: fixedArity(1, Math.exp),
	floor: fixedArity(1, Math.floor),
	hypot: rangedArity(1, 32, Math.hypot),
	ln: fixedArity(1, Math.log),
	log: rangedArity(1, 2, (value, base = Math.E) => Math.log(value) / Math.log(base)),
	log10: fixedArity(1, Math.log10),
	log2: fixedArity(1, Math.log2),
	max: rangedArity(1, 32, Math.max),
	min: rangedArity(1, 32, Math.min),
	pow: fixedArity(2, Math.pow),
	round: fixedArity(1, Math.round),
	sign: fixedArity(1, Math.sign),
	sin: fixedArity(1, Math.sin),
	sinh: fixedArity(1, Math.sinh),
	sqrt: fixedArity(1, Math.sqrt),
	tan: fixedArity(1, Math.tan),
	tanh: fixedArity(1, Math.tanh),
	trunc: fixedArity(1, Math.trunc)
});
const CONSTANTS = Object.freeze({
	e: Math.E,
	E: Math.E,
	pi: Math.PI,
	PI: Math.PI,
	tau: 2 * Math.PI,
	TAU: 2 * Math.PI,
	phi: (1 + Math.sqrt(5)) / 2,
	PHI: (1 + Math.sqrt(5)) / 2,
	sqrt2: Math.SQRT2,
	SQRT2: Math.SQRT2,
	ln2: Math.LN2,
	LN2: Math.LN2,
	ln10: Math.LN10,
	LN10: Math.LN10,
	log2e: Math.LOG2E,
	LOG2E: Math.LOG2E,
	log10e: Math.LOG10E,
	LOG10E: Math.LOG10E
});
function positiveLimit(value, fallback, name) {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError(`${name} must be a positive safe integer`);
	return resolved;
}
function resolveLimits(options) {
	return {
		maxLength: positiveLimit(options.maxLength, DEFAULT_LIMITS.maxLength, "maxLength"),
		maxNodes: positiveLimit(options.maxNodes, DEFAULT_LIMITS.maxNodes, "maxNodes"),
		maxSteps: positiveLimit(options.maxSteps, DEFAULT_LIMITS.maxSteps, "maxSteps"),
		maxDepth: positiveLimit(options.maxDepth, DEFAULT_LIMITS.maxDepth, "maxDepth"),
		...options.signal === void 0 ? {} : { signal: options.signal }
	};
}
function fail(code, message) {
	throw new ExpressionEvaluationError(code, message);
}
function finite(value, context) {
	if (!Number.isFinite(value)) fail("NON_FINITE_RESULT", `${context} produced NaN or Infinity`);
	return Object.is(value, -0) ? 0 : value;
}
var Lexer = class {
	input;
	index = 0;
	constructor(input) {
		this.input = input;
	}
	next() {
		while (this.index < this.input.length && /\s/.test(this.input[this.index] ?? "")) this.index += 1;
		const start = this.index;
		if (start >= this.input.length) return {
			kind: "eof",
			start
		};
		const current = this.input[start] ?? "";
		if (/\d/.test(current) || current === "." && /\d/.test(this.input[start + 1] ?? "")) {
			const match = NUMBER_PREFIX.exec(this.input.slice(start));
			if (match === null) fail("INVALID_EXPRESSION", `invalid number at position ${start + 1}`);
			this.index += match[0].length;
			return {
				kind: "number",
				value: finite(Number(match[0]), `number at position ${start + 1}`),
				start
			};
		}
		if (IDENTIFIER_START.test(current)) {
			this.index += 1;
			while (this.index < this.input.length && IDENTIFIER_CONTINUE.test(this.input[this.index] ?? "")) this.index += 1;
			return {
				kind: "identifier",
				value: this.input.slice(start, this.index),
				start
			};
		}
		this.index += 1;
		switch (current) {
			case "+":
			case "-":
			case "/":
			case "%": return {
				kind: "operator",
				value: current,
				start
			};
			case "*":
				if (this.input[this.index] === "*") {
					this.index += 1;
					return {
						kind: "operator",
						value: "**",
						start
					};
				}
				return {
					kind: "operator",
					value: "*",
					start
				};
			case "(": return {
				kind: "leftParen",
				start
			};
			case ")": return {
				kind: "rightParen",
				start
			};
			case ",": return {
				kind: "comma",
				start
			};
			default: fail("INVALID_EXPRESSION", `unsupported character ${JSON.stringify(current)} at position ${start + 1}`);
		}
	}
};
var Parser = class {
	limits;
	lexer;
	token;
	nodes = 0;
	steps = 0;
	depth = 0;
	constructor(input, limits) {
		this.limits = limits;
		this.lexer = new Lexer(input);
		this.token = this.lexer.next();
	}
	parse() {
		this.checkCancelled();
		const result = this.parseAdditive();
		if (this.token.kind !== "eof") fail("INVALID_EXPRESSION", `unexpected token at position ${this.token.start + 1}`);
		return finite(result, "expression");
	}
	advance() {
		this.token = this.lexer.next();
	}
	checkCancelled() {
		if (this.limits.signal?.aborted) fail("CANCELLED", "calculation was cancelled");
	}
	countNode() {
		this.checkCancelled();
		this.nodes += 1;
		if (this.nodes > this.limits.maxNodes) fail("LIMIT_EXCEEDED", `expression exceeds maxNodes=${this.limits.maxNodes}`);
	}
	countStep() {
		this.checkCancelled();
		this.steps += 1;
		if (this.steps > this.limits.maxSteps) fail("LIMIT_EXCEEDED", `expression exceeds maxSteps=${this.limits.maxSteps}`);
	}
	descend(parse) {
		this.depth += 1;
		if (this.depth > this.limits.maxDepth) {
			this.depth -= 1;
			return fail("LIMIT_EXCEEDED", `expression exceeds maxDepth=${this.limits.maxDepth}`);
		}
		try {
			return parse();
		} finally {
			this.depth -= 1;
		}
	}
	operator(value) {
		return this.token.kind === "operator" && this.token.value === value;
	}
	tokenKind() {
		return this.token.kind;
	}
	parseAdditive() {
		let value = this.parseMultiplicative();
		while (this.operator("+") || this.operator("-")) {
			const operator = this.token.kind === "operator" ? this.token.value : fail("INVALID_EXPRESSION", "operator invariant");
			this.advance();
			const right = this.parseMultiplicative();
			this.countNode();
			this.countStep();
			value = finite(operator === "+" ? value + right : value - right, `operator ${operator}`);
		}
		return value;
	}
	parseMultiplicative() {
		let value = this.parseUnary();
		while (this.operator("*") || this.operator("/") || this.operator("%")) {
			const operator = this.token.kind === "operator" ? this.token.value : fail("INVALID_EXPRESSION", "operator invariant");
			this.advance();
			const right = this.parseUnary();
			this.countNode();
			this.countStep();
			if (operator === "*") value = finite(value * right, "operator *");
			else if (operator === "/") value = finite(value / right, "operator /");
			else value = finite(value % right, "operator %");
		}
		return value;
	}
	parseUnary() {
		if (this.operator("+") || this.operator("-")) {
			const operator = this.token.kind === "operator" ? this.token.value : fail("INVALID_EXPRESSION", "operator invariant");
			this.advance();
			const value = this.descend(() => this.parseUnary());
			this.countNode();
			this.countStep();
			return finite(operator === "-" ? -value : value, `unary ${operator}`);
		}
		return this.parsePower();
	}
	parsePower() {
		const left = this.parsePrimary();
		if (!this.operator("**")) return left;
		this.advance();
		const right = this.descend(() => this.parseUnary());
		this.countNode();
		this.countStep();
		return finite(left ** right, "operator **");
	}
	parsePrimary() {
		if (this.token.kind === "number") {
			const value = this.token.value;
			this.advance();
			this.countNode();
			return value;
		}
		if (this.token.kind === "identifier") {
			const identifier = this.token.value;
			const position = this.token.start;
			this.advance();
			if (this.tokenKind() === "leftParen") return this.parseCall(identifier, position);
			const constant = Object.hasOwn(CONSTANTS, identifier) ? CONSTANTS[identifier] : void 0;
			if (constant === void 0) return fail("UNKNOWN_IDENTIFIER", `unknown identifier "${identifier}" at position ${position + 1}`);
			this.countNode();
			return constant;
		}
		if (this.token.kind === "leftParen") {
			const position = this.token.start;
			this.advance();
			const value = this.descend(() => this.parseAdditive());
			if (this.tokenKind() !== "rightParen") return fail("INVALID_EXPRESSION", `missing closing parenthesis for position ${position + 1}`);
			this.advance();
			return value;
		}
		return fail("INVALID_EXPRESSION", `expected a number, constant, function, or parenthesis at position ${this.token.start + 1}`);
	}
	parseCall(identifier, position) {
		const fn = Object.hasOwn(FUNCTIONS, identifier) ? FUNCTIONS[identifier] : void 0;
		if (fn === void 0) return fail("UNKNOWN_IDENTIFIER", `unknown function "${identifier}" at position ${position + 1}`);
		this.advance();
		const args = [];
		if (this.token.kind !== "rightParen") while (true) {
			args.push(this.descend(() => this.parseAdditive()));
			if (this.token.kind !== "comma") break;
			this.advance();
		}
		if (this.token.kind !== "rightParen") return fail("INVALID_EXPRESSION", `missing closing parenthesis for function "${identifier}"`);
		this.advance();
		if (args.length < fn.minArgs || args.length > fn.maxArgs) return fail("INVALID_ARITY", `function "${identifier}" expects ${fn.minArgs === fn.maxArgs ? String(fn.minArgs) : `${fn.minArgs}-${fn.maxArgs}`} argument(s), received ${args.length}`);
		this.countNode();
		this.countStep();
		return finite(fn.invoke(args), `function ${identifier}`);
	}
};
/** Evaluate one side-effect-free arithmetic expression using the fixed grammar. */
function evaluateExpression(expression, options = {}) {
	if (typeof expression !== "string") throw new TypeError("expression must be a string");
	const limits = resolveLimits(options);
	if (expression.length === 0 || expression.trim().length === 0) return fail("INVALID_EXPRESSION", "expression must not be empty");
	if (expression.length > limits.maxLength) return fail("LIMIT_EXCEEDED", `expression exceeds maxLength=${limits.maxLength}`);
	if (limits.signal?.aborted) return fail("CANCELLED", "calculation was cancelled");
	return new Parser(expression, limits).parse();
}
function parseToolArgs(args) {
	if (typeof args !== "object" || args === null || Array.isArray(args)) throw new TypeError("alphasolve_calculate arguments must be an object");
	const record = args;
	const keys = Object.keys(record);
	if (keys.length !== 1 || keys[0] !== "expression") throw new TypeError("alphasolve_calculate accepts only the expression argument");
	if (typeof record.expression !== "string") throw new TypeError("expression must be a string");
	return { expression: record.expression };
}
/** Construct the scoped calculator tool installed for approved helper roles. */
function createCalculatorTool(limits = {}) {
	return {
		name: CALCULATOR_TOOL_NAME,
		description: "Evaluate a bounded arithmetic expression without code execution. Supports numbers, scientific notation, + - * / % **, parentheses, and the documented finite math function/constant whitelist.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: { expression: {
				type: "string",
				description: "Arithmetic expression. Constants include pi, e, tau, phi, sqrt2; functions include abs, trig, log, sqrt, min, max, hypot, pow, round, and clamp."
			} },
			required: ["expression"]
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					expression: { type: "string" },
					value: { type: "number" }
				},
				required: ["expression", "value"]
			},
			render: (_args, value) => {
				const result = value;
				return [{
					type: "text",
					text: `${result.expression} = ${String(result.value)}`
				}];
			}
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const { expression } = parseToolArgs(args);
			return {
				expression,
				value: evaluateExpression(expression, {
					...limits,
					signal: exec.signal
				})
			};
		}
	};
}
//#endregion
//#region src/role-runner.ts
const ROLE_CREATE_TIMEOUT_MS = 6e4;
/** Abort only after one hour without any observable role or nested-helper activity. */
const ROLE_INACTIVITY_TIMEOUT_MS = 36e5;
const ROLE_DISPOSE_TIMEOUT_MS = 15e3;
var RoleTechnicalTimeoutError = class extends Error {
	phase;
	constructor(phase, milliseconds) {
		super(phase === "inactivity" ? `AlphaSolve role Agent had no observable activity for ${milliseconds}ms` : `AlphaSolve role Agent ${phase} timed out after ${milliseconds}ms`);
		this.phase = phase;
		this.name = "RoleTechnicalTimeoutError";
	}
};
const STANDARD_ROLE_FILE_TOOLS = /* @__PURE__ */ new Set([
	"read",
	"write",
	"edit",
	"glob",
	"grep"
]);
function technicalTimeout(value, fallback, label) {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${label} must be a positive safe integer`);
	return result;
}
async function withTechnicalTimeout(operation, milliseconds, phase, onTimeout) {
	let timer;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => {
			onTimeout();
			reject(new RoleTechnicalTimeoutError(phase, milliseconds));
		}, milliseconds);
		timer.unref?.();
	});
	try {
		return await Promise.race([operation, timeout]);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
function inactivityWatchdog(milliseconds, onTimeout) {
	let timer;
	let stopped = false;
	let rejectExpired;
	const expired = new Promise((_resolve, reject) => {
		rejectExpired = reject;
	});
	const refresh = () => {
		if (stopped) return;
		if (timer !== void 0) clearTimeout(timer);
		timer = setTimeout(() => {
			if (stopped) return;
			stopped = true;
			rejectExpired?.(new RoleTechnicalTimeoutError("inactivity", milliseconds));
			onTimeout();
		}, milliseconds);
		timer.unref?.();
	};
	const stop = () => {
		stopped = true;
		if (timer !== void 0) clearTimeout(timer);
		timer = void 0;
	};
	refresh();
	return {
		expired,
		refresh,
		stop
	};
}
function assertRunOptions(options) {
	if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1) throw new TypeError("maxTurns must be a positive safe integer");
	if (!path.isAbsolute(options.cwd)) throw new TypeError("role Agent cwd must be absolute");
	if (path.resolve(options.cwd) !== path.resolve(options.permissionPolicy.cwd)) throw new TypeError("role Agent cwd and permission policy cwd must identify the same lexical path");
	if (options.role !== options.permissionPolicy.role) throw new TypeError(`role Agent "${options.role}" cannot use a "${options.permissionPolicy.role}" permission policy`);
	if (options.persona.trim().length === 0) throw new TypeError("role Agent persona must not be empty");
	if (typeof options.prompt === "string" && options.prompt.trim().length === 0) throw new TypeError("role Agent prompt must not be empty");
	for (const name of options.allowedInheritedTools ?? []) {
		if (!STANDARD_ROLE_FILE_TOOLS.has(name)) throw new TypeError(`inherited tool "${name}" is not a standard AlphaSolve role filesystem tool`);
		if (!options.permissionPolicy.allowedTools.has(name)) throw new TypeError(`inherited tool "${name}" is not admitted by the ${options.role} permission policy`);
		if (isForbiddenRoleTool(name)) throw new TypeError(`global tool "${name}" is forbidden for role Agents`);
	}
}
function childAgentOptions(options) {
	const inherited = options.parent.options;
	const provider = options.modelSelection?.provider ?? inherited.provider;
	const model = options.modelSelection?.model ?? inherited.model;
	const maxTokens = options.maxTokens ?? inherited.maxTokens;
	return {
		...provider === void 0 ? {} : { provider },
		...model === void 0 ? {} : { model },
		...maxTokens === void 0 ? {} : { maxTokens }
	};
}
function promptBlocks(prompt) {
	return typeof prompt === "string" ? [{
		type: "text",
		text: prompt
	}] : [...prompt];
}
function mapStopReason(reason, hitMaxTurns, externallyAborted) {
	if (hitMaxTurns) return "max_turns";
	if (externallyAborted && reason?.kind !== "completed") return "aborted";
	switch (reason?.kind) {
		case "completed": return "completed";
		case "max-tokens": return "max_tokens";
		case "aborted": return reason.reason.kind === "disposed" ? "disposed" : "aborted";
		case "blocked": return "blocked";
		case "interrupted": return "interrupted";
		default: return "error";
	}
}
function readRoleResult(child, role, steps, hitMaxTurns, externallyAborted) {
	const events = child.session.events;
	const turnEnd = events.findLast((event) => event.type === "turn/end");
	const output = [...(turnEnd === void 0 ? void 0 : events.findLast((event) => event.type === "assistant/message" && event.data.turn === turnEnd.data.turn))?.data.message.content ?? []];
	return {
		agentId: child.id,
		role,
		output,
		text: output.filter((block) => block.type === "text").map((block) => block.text).join("\n"),
		stopReason: mapStopReason(turnEnd?.data.reason, hitMaxTurns, externallyAborted),
		steps,
		...turnEnd === void 0 ? {} : { turnEndReason: turnEnd.data.reason }
	};
}
function failurePhase(error) {
	return error instanceof RoleTechnicalTimeoutError ? error.phase : "run";
}
function reportFailure(options, agentId, phase, error, child, steps, cleanupError) {
	const partial = child === void 0 ? void 0 : readRoleResult(child, options.role, steps, false, options.signal.aborted);
	const unterminatedMessage = child !== void 0 && partial?.turnEndReason === void 0 ? child.session.events.findLast((event) => event.type === "assistant/message") : void 0;
	const output = partial?.output.length === 0 && unterminatedMessage !== void 0 ? [...unterminatedMessage.data.message.content] : partial?.output ?? [];
	const text = output.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	try {
		options.onFailure?.({
			agentId: String(agentId),
			role: options.role,
			phase,
			output,
			text,
			steps,
			error,
			...cleanupError === void 0 ? {} : { cleanupError },
			...partial?.turnEndReason === void 0 ? {} : { turnEndReason: partial.turnEndReason }
		});
	} catch {}
}
function deriveInheritedAllowlist(childCtx, child, policy) {
	return [...STANDARD_ROLE_FILE_TOOLS].filter((name) => policy.allowedTools.has(name) && childCtx.tools.get(name, child) !== void 0);
}
/**
* Run one fresh, single-turn DSH Agent with role-scoped prompt, route, tools,
* path policy, cancellation, and an AlphaSolve max-step boundary.
*/
async function runRoleAgent(options) {
	assertRunOptions(options);
	const createTimeoutMs = technicalTimeout(options.createTimeoutMs, ROLE_CREATE_TIMEOUT_MS, "createTimeoutMs");
	const inactivityTimeoutMs = technicalTimeout(options.inactivityTimeoutMs, ROLE_INACTIVITY_TIMEOUT_MS, "inactivityTimeoutMs");
	const disposeTimeoutMs = technicalTimeout(options.disposeTimeoutMs, ROLE_DISPOSE_TIMEOUT_MS, "disposeTimeoutMs");
	const childId = SessionId(randomUUID());
	let hitMaxTurns = false;
	let observedSteps = 0;
	let handle;
	const lifetime = new AbortController();
	const creationSignal = AbortSignal.any([options.signal, lifetime.signal]);
	let refreshInactivity = () => void 0;
	const reportActivity = () => {
		refreshInactivity();
		options.onActivity?.();
	};
	const agentPreset = options.parent.ctx.get("agentPresets")?.composedPreset(options.parent.ctx);
	const creation = options.parent.ctx.agents.create({
		sessionId: childId,
		meta: {
			cwd: path.resolve(options.cwd),
			parentSession: options.parent.id,
			origin: "subagent",
			delegationDepth: (options.parent.session.header.delegationDepth ?? 0) + 1,
			...agentPreset === void 0 ? {} : { agentPreset }
		},
		agentOptions: childAgentOptions(options),
		signal: creationSignal,
		setup: async (childCtx) => {
			const child = childCtx.agent;
			if (child === void 0) throw new Error("Agent factory did not associate the unpublished child context");
			if (childCtx.get("agentPresets")?.composeFrom(childCtx, options.parent.ctx) !== agentPreset) throw new Error("AlphaSolve role Agent did not join the parent Agent preset selected at creation");
			childCtx.tools.presentAs("native");
			childCtx.systemPrompt.section({
				name: "deployment:persona",
				order: 0,
				text: options.persona
			});
			if (options.modelSelection !== void 0) installModelSelection(childCtx, {
				current: options.modelSelection,
				assembled: void 0
			});
			installRolePermissionBoundary(childCtx, options.permissionPolicy);
			const allowedInherited = options.allowedInheritedTools === void 0 ? deriveInheritedAllowlist(childCtx, child, options.permissionPolicy) : [...options.allowedInheritedTools];
			childCtx.tools.restrict({ allow: allowedInherited });
			childCtx.on("session/event", (session, event) => {
				if (session !== child.session) return;
				reportActivity();
				if (event.type === "step/start") observedSteps = Math.max(observedSteps, event.data.step);
			});
			childCtx.on("agent/pre-step", ({ agent, step }, next) => {
				reportActivity();
				if (step > options.maxTurns) {
					hitMaxTurns = true;
					agent.cancel({ kind: "parent" });
					return Promise.resolve({ kind: "reject" });
				}
				return next();
			});
			await options.setupHelpers?.(childCtx, child, reportActivity);
		}
	});
	try {
		handle = await withTechnicalTimeout(creation, createTimeoutMs, "create", () => {
			lifetime.abort(new RoleTechnicalTimeoutError("create", createTimeoutMs));
		});
	} catch (error) {
		creation.then((late) => late.dispose()).catch(() => void 0);
		reportFailure(options, childId, "create", error, void 0, observedSteps);
		throw error;
	}
	const child = handle.agent;
	let externallyAborted = options.signal.aborted;
	const onAbort = () => {
		externallyAborted = true;
		child.cancel({ kind: "parent" });
	};
	options.signal.addEventListener("abort", onAbort, { once: true });
	if (options.signal.aborted) onAbort();
	let result;
	let primaryError;
	let primaryPhase;
	let cleanupError;
	try {
		const watchdog = inactivityWatchdog(inactivityTimeoutMs, () => {
			lifetime.abort(new RoleTechnicalTimeoutError("inactivity", inactivityTimeoutMs));
			child.cancel({ kind: "parent" });
		});
		refreshInactivity = watchdog.refresh;
		if (!externallyAborted) {
			reportActivity();
			child.followup(createUserMessage({
				content: promptBlocks(options.prompt),
				source: { kind: "user" }
			}));
		}
		try {
			await Promise.race([child.whenIdle(), watchdog.expired]);
		} finally {
			watchdog.stop();
			refreshInactivity = () => void 0;
		}
		result = readRoleResult(child, options.role, hitMaxTurns ? options.maxTurns : observedSteps, hitMaxTurns, externallyAborted);
	} catch (error) {
		primaryError = error;
		primaryPhase = failurePhase(error);
	} finally {
		options.signal.removeEventListener("abort", onAbort);
		lifetime.abort(/* @__PURE__ */ new Error("AlphaSolve role invocation finished"));
		try {
			const disposal = handle.dispose();
			try {
				await withTechnicalTimeout(disposal, disposeTimeoutMs, "dispose", () => {
					child.cancel({ kind: "parent" });
				});
			} catch (error) {
				disposal.catch(() => void 0);
				cleanupError = error;
			}
		} catch (error) {
			cleanupError = error;
		}
	}
	if (primaryError !== void 0) {
		reportFailure(options, child.id, primaryPhase ?? failurePhase(primaryError), primaryError, child, hitMaxTurns ? options.maxTurns : observedSteps, cleanupError);
		throw primaryError;
	}
	if (cleanupError !== void 0) {
		reportFailure(options, child.id, "dispose", cleanupError, child, hitMaxTurns ? options.maxTurns : observedSteps);
		throw cleanupError;
	}
	if (result === void 0) throw new Error("AlphaSolve role runner ended without a result");
	return result;
}
//#endregion
//#region src/research-tools.ts
/** Read-only Markdown navigation helpers for the AlphaSolve research reviewer. */
const RESEARCH_REVIEW_TOOL_NAMES = Object.freeze({
	progress: "alphasolve_research_progress_review",
	inspectMarkdown: "alphasolve_inspect_markdown"
});
const AUTO_ROOTS = [
	"problem.md",
	"verified_propositions",
	"knowledge"
];
const REVIEW_SECTION = /\b(?:statement|current status|progress|remaining gaps?|open gaps?|blockers?|index)\b/i;
const STATEMENT_SECTION = /\bstatement\b/i;
const PROOF_SECTION = /\bproof\b/i;
const GAP_SECTION = /\b(?:remaining gaps?|open gaps?|blockers?|obstacles?|todo|next steps?)\b/i;
const GAP_SIGNAL = /\b(?:remaining gaps?|open gaps?|blockers?|obstacles?|unresolved|missing|todo|stuck|failed)\b/i;
const CONCLUSION_SIGNAL = /\b(?:therefore|hence|thus|consequently|implies|proves?|proved|complete|solved|qed|optimal|exact)\b|(?:所以|因此|从而|故|得证|已解决|最优|精确)/i;
const ANSWER_SIGNAL = /\b(?:answer|objective|optimum|optimal|exact|value|bound|classification|construction|target|stopping)\b|(?:答案|目标|最优|界|分类|构造|停止)/i;
const FOCUS_STOPWORDS = /* @__PURE__ */ new Set([
	"about",
	"after",
	"also",
	"because",
	"before",
	"could",
	"determine",
	"find",
	"from",
	"given",
	"have",
	"into",
	"problem",
	"prove",
	"show",
	"that",
	"their",
	"there",
	"these",
	"this",
	"using",
	"what",
	"when",
	"where",
	"which",
	"with",
	"would"
]);
function boundedInteger(value, fallback, maximum, label) {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`${label} must be an integer from 1 to ${maximum}`);
	return result;
}
function allowedRelative(input) {
	if (input === ".") return input;
	const relative = normalizeRelativePath(input);
	if (relative === "problem.md" || relative === "knowledge" || relative.startsWith("knowledge/") || relative === "verified_propositions" || relative.startsWith("verified_propositions/")) return relative;
	throw new WorkspaceError("research review is restricted to problem.md, knowledge/, and verified_propositions/", input);
}
function posixRelative(root, absolute) {
	return path.relative(root, absolute).split(path.sep).join("/");
}
function selectedSection(lines, maximum) {
	const heading = lines.findIndex((line) => /^#{1,6}\s+/.test(line) && REVIEW_SECTION.test(line));
	if (heading < 0) return lines.slice(0, Math.min(maximum, lines.length)).join("\n");
	let end = heading + 1;
	while (end < lines.length && end - heading < maximum && !/^#{1,6}\s+/.test(lines[end] ?? "")) end += 1;
	return lines.slice(heading, end).join("\n");
}
function reviewEntry(relative, content, tailLines, statementLines) {
	const lines = content.split(/\r\n|\n|\r/);
	return {
		path: relative,
		headings: lines.filter((line) => /^#{1,6}\s+/.test(line)).slice(0, 80),
		statementOrProgress: selectedSection(lines, statementLines),
		tail: lines.slice(Math.max(0, lines.length - tailLines)).join("\n"),
		totalLines: lines.length
	};
}
function sectionMatching(lines, pattern, maximum) {
	const heading = lines.findIndex((line) => /^#{1,6}\s+/.test(line) && pattern.test(line));
	if (heading < 0) return "";
	const level = /^(#{1,6})\s+/.exec(lines[heading] ?? "")?.[1]?.length ?? 6;
	let end = heading + 1;
	while (end < lines.length && end - heading < maximum) {
		const next = /^(#{1,6})\s+/.exec(lines[end] ?? "");
		if (next !== null && (next[1]?.length ?? 6) <= level) break;
		end += 1;
	}
	return lines.slice(heading, end).join("\n").trim();
}
function proofTail(lines, maximum) {
	let proofHeading = -1;
	for (let index = 0; index < lines.length; index += 1) if (/^#{1,6}\s+/.test(lines[index] ?? "") && PROOF_SECTION.test(lines[index] ?? "")) proofHeading = index;
	if (proofHeading < 0) return lines.slice(Math.max(0, lines.length - maximum)).join("\n").trim();
	const level = /^(#{1,6})\s+/.exec(lines[proofHeading] ?? "")?.[1]?.length ?? 6;
	let end = proofHeading + 1;
	while (end < lines.length) {
		const next = /^(#{1,6})\s+/.exec(lines[end] ?? "");
		if (next !== null && (next[1]?.length ?? 6) <= level) break;
		end += 1;
	}
	return lines.slice(Math.max(proofHeading, end - maximum), end).join("\n").trim();
}
function truncateHead(value, maximum) {
	if (value.length <= maximum) return value;
	if (maximum <= 1) return value.slice(0, maximum);
	return `${value.slice(0, maximum - 1).trimEnd()}…`;
}
function truncateTail(value, maximum) {
	if (value.length <= maximum) return value;
	if (maximum <= 1) return value.slice(-maximum);
	return `…${value.slice(-(maximum - 1)).trimStart()}`;
}
function candidateGroup(relative) {
	if (relative === "problem.md") return "problem";
	const basename = path.posix.basename(relative).toLowerCase();
	if (relative.startsWith("verified_propositions/")) return basename === "index.md" || basename === "state.md" ? "verified_index" : "verified";
	return basename === "index.md" || basename === "state.md" ? "knowledge_index" : "knowledge";
}
function groupPriority(group) {
	return group === "problem" ? 0 : group === "verified_index" ? 1 : group === "verified" ? 2 : group === "knowledge_index" ? 3 : 4;
}
function focusTerms(problem) {
	const terms = problem.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? [];
	return [...new Set(terms.filter((term) => !FOCUS_STOPWORDS.has(term)))].slice(0, 40);
}
function progressEntry(relative, content) {
	const lines = content.split(/\r\n|\n|\r/);
	const group = candidateGroup(relative);
	let statementOrProgress;
	let tail = "";
	if (group === "problem") statementOrProgress = lines.slice(0, 24).join("\n").trim();
	else if (group === "verified" || group === "verified_index") {
		statementOrProgress = sectionMatching(lines, STATEMENT_SECTION, 20) || selectedSection(lines, 16).trim();
		tail = proofTail(lines, 12);
	} else {
		statementOrProgress = sectionMatching(lines, GAP_SECTION, 18) || selectedSection(lines, 16).trim();
		tail = GAP_SIGNAL.test(statementOrProgress) ? "" : lines.slice(Math.max(0, lines.length - 8)).join("\n").trim();
	}
	if (tail === statementOrProgress) tail = "";
	return {
		path: relative,
		headings: lines.filter((line) => /^#{1,6}\s+/.test(line)).slice(0, 12),
		statementOrProgress,
		tail,
		totalLines: lines.length
	};
}
function scoreCandidate(relative, content, problemTerms) {
	const entry = progressEntry(relative, content);
	const lower = content.toLocaleLowerCase();
	const focus = problemTerms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
	const signalLines = content.split(/\r\n|\n|\r/);
	const gaps = Math.min(10, signalLines.filter((line) => GAP_SIGNAL.test(line)).length);
	const conclusions = Math.min(8, signalLines.slice(-30).filter((line) => !/^\s*>/.test(line) && CONCLUSION_SIGNAL.test(line)).length);
	const answerChanging = ANSWER_SIGNAL.test(entry.tail) || ANSWER_SIGNAL.test(entry.statementOrProgress);
	const basename = path.posix.basename(relative).toLocaleLowerCase();
	const pathSignal = /(?:gap|blocker|progress|status|summary|result|objective|answer)/i.test(basename) ? 30 : 0;
	const depth = relative.split("/").length;
	const referencePenalty = relative.startsWith("knowledge/references/") ? 120 : 0;
	return {
		entry,
		group: candidateGroup(relative),
		score: focus * 24 + gaps * 14 + conclusions * 12 + (answerChanging ? 40 : 0) + pathSignal - depth * 8 - referencePenalty,
		depth
	};
}
function compareCandidates(left, right) {
	return groupPriority(left.group) - groupPriority(right.group) || right.score - left.score || left.depth - right.depth || left.entry.path.localeCompare(right.entry.path);
}
function selectCandidates(candidates) {
	const target = Math.min(16, candidates.length);
	const selected = [];
	const selectedPaths = /* @__PURE__ */ new Set();
	const quotas = {
		problem: 1,
		verified_index: 1,
		verified: 8,
		knowledge_index: 1,
		knowledge: 5
	};
	const add = (candidate) => {
		if (selected.length >= target || selectedPaths.has(candidate.entry.path)) return;
		selected.push(candidate);
		selectedPaths.add(candidate.entry.path);
	};
	for (const group of [
		"problem",
		"verified_index",
		"verified",
		"knowledge_index",
		"knowledge"
	]) for (const candidate of candidates.filter((item) => item.group === group).sort((left, right) => right.score - left.score || left.depth - right.depth || left.entry.path.localeCompare(right.entry.path)).slice(0, quotas[group])) add(candidate);
	for (const candidate of [...candidates].sort(compareCandidates)) add(candidate);
	return selected.sort(compareCandidates);
}
function compactEntry(entry, limits) {
	return {
		...entry,
		headings: entry.headings.slice(0, limits.headings).map((heading) => truncateHead(heading, limits.headingChars)),
		statementOrProgress: truncateHead(entry.statementOrProgress, limits.statement),
		tail: truncateTail(entry.tail, limits.tail)
	};
}
function budgetedProgressResult(selected, scanned, sourceTruncated) {
	let files = selected.map((candidate) => compactEntry(candidate.entry, {
		headings: 5,
		headingChars: 120,
		statement: candidate.group === "problem" ? 1400 : 650,
		tail: 500
	}));
	const build = () => ({
		files,
		scanned,
		truncated: sourceTruncated || files.length < scanned,
		suggestedInspectionPaths: files.slice(0, 12).map((file) => file.path)
	});
	const size = () => JSON.stringify(build()).length;
	const normalMinimum = Math.min(10, files.length);
	while (size() > 24e3 && files.length > normalMinimum) files = files.slice(0, -1);
	if (size() > 24e3) files = files.map((file) => compactEntry(file, {
		headings: 3,
		headingChars: 90,
		statement: file.path === "problem.md" ? 700 : 360,
		tail: 260
	}));
	while (size() > 24e3 && files.length > 1) files = files.slice(0, -1);
	if (size() > 24e3) files = files.map((file) => compactEntry(file, {
		headings: 1,
		headingChars: 60,
		statement: 120,
		tail: 100
	}));
	while (size() > 24e3 && files.length > 1) files = files.slice(0, -1);
	return build();
}
/** Scans no path outside the research reviewer's frozen read boundary. */
var ResearchReviewTools = class ResearchReviewTools {
	workspaceRoot;
	constructor(workspaceRoot) {
		this.workspaceRoot = workspaceRoot;
	}
	static async create(workspace) {
		return new ResearchReviewTools(await canonicalWorkspace(workspace));
	}
	async collect(inputs, maximum) {
		const roots = (inputs.length === 0 ? ["."] : inputs).flatMap((input) => allowedRelative(input) === "." ? [...AUTO_ROOTS] : [allowedRelative(input)]);
		const found = /* @__PURE__ */ new Set();
		const pending = [...roots].reverse();
		let truncated = false;
		while (pending.length > 0) {
			const relative = pending.pop();
			if (relative === void 0 || found.has(relative)) continue;
			const absolute = await resolveWorkspacePath(this.workspaceRoot, relative, { mustExist: true });
			const info = await lstat(absolute);
			if (info.isSymbolicLink()) throw new WorkspaceError("research review does not follow symbolic links", relative);
			if (info.isFile()) {
				if (path.extname(relative).toLowerCase() !== ".md") throw new WorkspaceError("research review accepts only Markdown files", relative);
				if (found.size >= maximum) {
					truncated = true;
					break;
				}
				found.add(relative);
				continue;
			}
			if (!info.isDirectory()) throw new WorkspaceError("research review path is not a file or directory", relative);
			const children = await readdir(absolute, { withFileTypes: true });
			for (const child of children.sort((left, right) => right.name.localeCompare(left.name))) {
				const childAbsolute = path.join(absolute, child.name);
				const childRelative = posixRelative(this.workspaceRoot, childAbsolute);
				allowedRelative(childRelative);
				if (child.isSymbolicLink()) throw new WorkspaceError("research review does not follow symbolic links", childRelative);
				if (child.isDirectory() || child.isFile() && child.name.toLowerCase().endsWith(".md")) pending.push(childRelative);
			}
		}
		return {
			paths: [...found],
			truncated
		};
	}
	/** Share broad scan capacity across roots so one large tree cannot hide the others. */
	async collectProgress(inputs, maximum) {
		const requested = inputs.length === 0 ? ["."] : inputs;
		const roots = [...new Set(requested.flatMap((input) => allowedRelative(input) === "." ? [...AUTO_ROOTS] : [allowedRelative(input)]))];
		const paths = [];
		const seen = /* @__PURE__ */ new Set();
		let remaining = maximum;
		let truncated = false;
		for (let index = 0; index < roots.length; index += 1) {
			if (remaining <= 0) {
				truncated = true;
				break;
			}
			const slots = Math.max(1, Math.floor(remaining / (roots.length - index)));
			const collected = await this.collect([roots[index]], slots);
			truncated ||= collected.truncated;
			for (const relative of collected.paths) {
				if (seen.has(relative) || paths.length >= maximum) continue;
				seen.add(relative);
				paths.push(relative);
				remaining -= 1;
			}
		}
		return {
			paths,
			truncated
		};
	}
	async inspectMarkdown(requestedPath = ".", options = {}) {
		const maxFiles = boundedInteger(options.maxFiles, 8, 100, "maxFiles");
		const tailLines = boundedInteger(options.tailLines, 40, 200, "tailLines");
		const statementLines = boundedInteger(options.statementLines, 80, 300, "statementLines");
		const collected = await this.collect([requestedPath], maxFiles);
		const files = await Promise.all(collected.paths.map(async (relative) => {
			return reviewEntry(relative, (await readWorkspaceInput(this.workspaceRoot, relative, { nonEmpty: false })).content, tailLines, statementLines);
		}));
		return {
			files,
			scanned: files.length,
			truncated: collected.truncated,
			suggestedInspectionPaths: files.map((file) => file.path)
		};
	}
	async progressReview(options = {}) {
		const maxFiles = boundedInteger(options.maxFiles, 200, 500, "maxFiles");
		const requested = options.paths !== void 0 && options.paths.length > 0 ? options.paths : [options.path ?? "."];
		const collected = await this.collectProgress(requested, maxFiles);
		const contents = await Promise.all(collected.paths.map(async (relative) => {
			return {
				relative,
				content: (await readWorkspaceInput(this.workspaceRoot, relative, { nonEmpty: false })).content
			};
		}));
		let problem = contents.find((item) => item.relative === "problem.md")?.content ?? "";
		if (problem === "") try {
			problem = (await readWorkspaceInput(this.workspaceRoot, "problem.md", { nonEmpty: false })).content;
		} catch (error) {
			if (!(error instanceof WorkspaceError && error.message.startsWith("required path does not exist"))) throw error;
		}
		const problemTerms = focusTerms(problem);
		const candidates = contents.map((item) => scoreCandidate(item.relative, item.content, problemTerms));
		return budgetedProgressResult(selectCandidates(candidates), candidates.length, collected.truncated);
	}
};
async function createResearchReviewTools(workspace) {
	return ResearchReviewTools.create(workspace);
}
//#endregion
//#region src/role-service.ts
/** Production bridge from the fixed AlphaSolve workflow to fresh DSH role Agents. */
const SUBAGENT_TOOL_NAME = "alphasolve_subagent";
const CURATOR_TOOL_NAMES = Object.freeze({
	read: "alphasolve_curator_read",
	write: "alphasolve_curator_write",
	edit: "alphasolve_curator_edit",
	mkdir: "alphasolve_curator_mkdir",
	rename: "alphasolve_curator_rename",
	move: "alphasolve_curator_move",
	splitReference: "alphasolve_curator_split_reference",
	delete: "alphasolve_curator_delete",
	list: "alphasolve_curator_list",
	glob: "alphasolve_curator_glob",
	grep: "alphasolve_curator_grep"
});
var RoleAgentDidNotCompleteError = class extends Error {
	label;
	result;
	constructor(label, result) {
		super(`AlphaSolve ${label} Agent stopped with ${result.stopReason}`);
		this.label = label;
		this.result = result;
		this.name = "RoleAgentDidNotCompleteError";
	}
};
const SUBAGENT_TYPES = /* @__PURE__ */ new Set([
	"compute",
	"numerical_experiment",
	"research_reviewer",
	"reasoning"
]);
const CURATOR_TOOLS = Object.freeze(Object.values(CURATOR_TOOL_NAMES));
const PATH_RESULT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: { path: { type: "string" } },
	required: ["path"]
};
function throwIfAborted$1(signal) {
	if (signal.aborted) throw signal.reason ?? new DOMException("role call cancelled", "AbortError");
}
function argumentRecord$2(args, tool) {
	if (typeof args !== "object" || args === null || Array.isArray(args)) throw new TypeError(`${tool} arguments must be an object`);
	return args;
}
function exactKeys$1(record, allowed, tool) {
	const allowedSet = new Set(allowed);
	const unexpected = Object.keys(record).filter((key) => !allowedSet.has(key));
	if (unexpected.length > 0) throw new TypeError(`${tool} received unexpected argument ${unexpected[0]}`);
}
function stringArgument(record, field, tool) {
	const value = record[field];
	if (typeof value !== "string") throw new TypeError(`${tool}.${field} must be a string`);
	return value;
}
function optionalStringArgument(record, field, tool) {
	const value = record[field];
	if (value === void 0) return void 0;
	if (typeof value !== "string") throw new TypeError(`${tool}.${field} must be a string`);
	return value;
}
function optionalIntegerArgument(record, field, tool) {
	const value = record[field];
	if (value === void 0) return void 0;
	if (!Number.isSafeInteger(value)) throw new TypeError(`${tool}.${field} must be a safe integer`);
	return value;
}
function optionalBooleanArgument(record, field, tool) {
	const value = record[field];
	if (value === void 0) return void 0;
	if (typeof value !== "boolean") throw new TypeError(`${tool}.${field} must be a boolean`);
	return value;
}
function jsonTool$1(options) {
	return {
		name: options.name,
		description: options.description,
		parameters: options.parameters,
		output: {
			schema: options.outputSchema,
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute: options.execute
	};
}
function workflowRoleKind(role) {
	switch (role) {
		case "generator": return "generator";
		case "verifier_citation": return "verifier_citation";
		case "verifier_format_references":
		case "verifier_failure_modes":
		case "verifier_stepwise":
		case "verifier_premise_chain":
		case "review_verdict_judge": return "verifier";
		case "reviser": return "reviser";
		case "theorem_checker": return "theorem_checker";
	}
}
function modelRole(role) {
	switch (role) {
		case "generator": return "generator";
		case "verifier":
		case "verifier_citation": return "verifier";
		case "reviser": return "reviser";
		case "theorem_checker": return "theorem_checker";
		case "curator":
		case "curator_helper": return "curator";
		case "compute": return "compute";
		case "numerical_experiment": return "numerical_experiment";
		case "research_reviewer": return "research_reviewer";
		case "reasoning": return "reasoning";
		case "verifier_format_references":
		case "verifier_failure_modes":
		case "verifier_stepwise":
		case "verifier_premise_chain":
		case "review_verdict_judge": return "verifier";
		case "orchestrator": throw new TypeError("the orchestrator is not a role-service child route");
	}
}
function allowedSubagents(role) {
	return ROLE_SUBAGENTS[role];
}
function readRoots(policy) {
	return [...new Set(policy.paths.filter((rule) => (rule.effect ?? "allow") === "allow" && rule.access.includes("read")).map((rule) => rule.root))];
}
function completed(result, label) {
	if (result.stopReason !== "completed") throw new RoleAgentDidNotCompleteError(label, result);
	return result;
}
function traceEvent(kind, role, task, result, context = {}) {
	return Object.freeze({
		kind,
		role,
		task,
		text: result.text,
		stopReason: result.stopReason,
		steps: result.steps,
		agentId: String(result.agentId),
		...context.workerId === void 0 ? {} : { workerId: context.workerId },
		...context.parentRole === void 0 ? {} : { parentRole: context.parentRole }
	});
}
function traceError(error) {
	if (error instanceof Error) {
		const code = "code" in error && typeof error.code === "string" ? error.code : void 0;
		return Object.freeze({
			name: error.name || "Error",
			message: error.message,
			...code === void 0 ? {} : { code }
		});
	}
	return Object.freeze({
		name: typeof error,
		message: String(error)
	});
}
function failedTraceEvent(kind, role, task, failure, context = {}) {
	return Object.freeze({
		kind,
		role,
		task,
		text: failure.text,
		stopReason: "error",
		steps: failure.steps,
		agentId: failure.agentId,
		phase: failure.phase,
		error: traceError(failure.error),
		...failure.cleanupError === void 0 ? {} : { cleanupError: traceError(failure.cleanupError) },
		...failure.turnEndReason === void 0 ? {} : { turnEndReason: failure.turnEndReason },
		...context.workerId === void 0 ? {} : { workerId: context.workerId },
		...context.parentRole === void 0 ? {} : { parentRole: context.parentRole }
	});
}
function subagentArguments(args) {
	const record = argumentRecord$2(args, SUBAGENT_TOOL_NAME);
	exactKeys$1(record, ["type", "task"], SUBAGENT_TOOL_NAME);
	const type = stringArgument(record, "type", SUBAGENT_TOOL_NAME);
	const task = stringArgument(record, "task", SUBAGENT_TOOL_NAME);
	if (!SUBAGENT_TYPES.has(type)) throw new TypeError(`unsupported AlphaSolve subagent type: ${type}`);
	if (task.trim().length === 0) throw new TypeError("alphasolve_subagent.task must not be empty");
	return {
		type,
		task
	};
}
function safeWorkerId$1(workerId) {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workerId)) throw new TypeError(`unsafe AlphaSolve worker id: ${workerId}`);
	return workerId;
}
/**
* Session-owned implementation of RoleInvoker and the auxiliary AlphaSolve
* Agent routes. No Agent or scoped tool is shared between calls.
*/
var AlphaSolveRoleService = class {
	parent;
	workspace;
	getConfig;
	onTrace;
	runner;
	workerArtifactPaths = /* @__PURE__ */ new Map();
	constructor(options) {
		if (!path.isAbsolute(options.workspace)) throw new TypeError("AlphaSolve role-service workspace must be absolute");
		this.parent = options.parent;
		this.workspace = path.resolve(options.workspace);
		this.getConfig = options.getConfig;
		this.onTrace = options.onTrace;
		this.runner = options.runner ?? runRoleAgent;
	}
	inheritedModelSelection() {
		const logged = this.parent.session.requestHeader()?.config;
		const provider = logged?.provider ?? this.parent.options.provider;
		const model = logged?.model ?? this.parent.options.model;
		if (provider === void 0 || provider.trim().length === 0 || model === void 0 || model.trim().length === 0) throw new Error("AlphaSolve cannot inherit a model route before the main session has selected provider and model");
		return Object.freeze({
			provider,
			model,
			...logged?.reasoningEffort === void 0 ? {} : { reasoningEffort: logged.reasoningEffort }
		});
	}
	modelSelection(role) {
		return resolveRoleModelSelection(modelRole(role), this.inheritedModelSelection(), this.getConfig().models);
	}
	async runWithTrace(options, trace) {
		let reportedFailure;
		let result;
		try {
			result = await this.runner({
				...options,
				onFailure: (failure) => {
					reportedFailure = failure;
					options.onFailure?.(failure);
				}
			});
		} catch (error) {
			const failure = reportedFailure ?? {
				agentId: "unavailable",
				role: options.role,
				phase: "run",
				output: [],
				text: "",
				steps: 0,
				error
			};
			const event = failedTraceEvent(trace.kind, trace.role, trace.task, failure, trace);
			try {
				await this.recordTrace(event, trace.workerId);
			} catch {}
			throw error;
		}
		const event = traceEvent(trace.kind, trace.role, trace.task, result, trace);
		await this.recordTrace(event, trace.workerId);
		completed(result, String(trace.role));
		return {
			result,
			trace: event
		};
	}
	async recordTrace(event, workerId) {
		const artifactPath = await this.onTrace?.(event);
		if (artifactPath !== void 0 && workerId !== void 0) {
			let paths = this.workerArtifactPaths.get(workerId);
			if (paths === void 0) {
				paths = /* @__PURE__ */ new Set();
				this.workerArtifactPaths.set(workerId, paths);
			}
			paths.add(artifactPath);
		}
	}
	/** Durable trace paths accumulated for one worker, including helper traces. */
	artifactPaths(workerId) {
		return [...this.workerArtifactPaths.get(workerId) ?? []].sort();
	}
	workflowPolicy(request, extraAllowedTools) {
		return createRolePolicy(workflowRoleKind(request.role), {
			workspace: request.cwd,
			knowledgeDirectory: path.join(request.workspace, "knowledge"),
			verifiedDirectory: path.join(request.workspace, "verified_propositions"),
			workerDirectory: request.workerDirectory,
			propositionFile: request.propositionPath,
			...request.theoremViewDirectory === void 0 ? {} : { theoremViewDirectory: request.theoremViewDirectory },
			extraAllowedTools
		});
	}
	helperSetup(callerRole, workerId, callerPolicy) {
		const admitted = allowedSubagents(callerRole);
		return (ctx, child, reportActivity = () => void 0) => {
			ctx.tools.register(this.createSubagentTool(callerRole, workerId, child, callerPolicy, admitted, reportActivity));
		};
	}
	createSubagentTool(callerRole, workerId, child, callerPolicy, admitted, reportActivity) {
		return jsonTool$1({
			name: SUBAGENT_TOOL_NAME,
			description: `Run one fresh, bounded AlphaSolve helper. Allowed types for this role: ${admitted.join(", ")}.`,
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					type: { type: "string" },
					task: { type: "string" }
				},
				required: ["type", "task"]
			},
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					type: { type: "string" },
					result: { type: "string" }
				},
				required: ["type", "result"]
			},
			execute: async (args, exec) => {
				reportActivity();
				const request = subagentArguments(args);
				if (!admitted.includes(request.type)) throw new Error(`AlphaSolve role "${callerRole}" cannot launch subagent type "${request.type}"`);
				throwIfAborted$1(exec.signal);
				const calculator = request.type === "compute" || request.type === "numerical_experiment";
				const helperPolicy = createRolePolicy(request.type, {
					workspace: this.workspace,
					delegatedReadRoots: readRoots(callerPolicy),
					extraAllowedTools: calculator ? [CALCULATOR_TOOL_NAME] : []
				});
				const run = await this.runWithTrace({
					parent: child,
					role: request.type,
					cwd: this.workspace,
					persona: loadRolePrompt(request.type),
					prompt: request.task,
					maxTurns: ROLE_MAX_TURNS[request.type],
					signal: exec.signal,
					permissionPolicy: helperPolicy,
					modelSelection: this.modelSelection(request.type),
					onActivity: reportActivity,
					...calculator ? { setupHelpers: (helperCtx) => {
						helperCtx.tools.register(createCalculatorTool());
					} } : {}
				}, {
					kind: "subagent",
					role: request.type,
					task: request.task,
					...workerId === void 0 ? {} : { workerId },
					parentRole: callerRole
				});
				return {
					type: request.type,
					result: run.result.text
				};
			}
		});
	}
	async invoke(request) {
		throwIfAborted$1(request.signal);
		const helperEnabled = allowedSubagents(request.role).length > 0;
		const policy = this.workflowPolicy(request, helperEnabled ? [SUBAGENT_TOOL_NAME] : []);
		const role = workflowRoleKind(request.role);
		const run = await this.runWithTrace({
			parent: this.parent,
			role,
			cwd: request.cwd,
			persona: request.persona,
			prompt: request.task,
			maxTurns: request.maxTurns,
			signal: request.signal,
			permissionPolicy: policy,
			modelSelection: this.modelSelection(request.role),
			...request.role === "review_verdict_judge" ? { allowedInheritedTools: [] } : {},
			...helperEnabled ? { setupHelpers: this.helperSetup(request.role, request.workerId, policy) } : {}
		}, {
			kind: "workflow_role",
			role: request.role,
			task: request.task,
			workerId: request.workerId
		});
		return {
			text: run.result.text,
			...this.getConfig().detailedTrace ? { trace: [run.trace] } : {}
		};
	}
	/** No-tool, one-step generator-model route used only to name a verified proposition. */
	buildPropositionFilename = async (request) => {
		throwIfAborted$1(request.signal);
		const workerId = safeWorkerId$1(request.workerId);
		const workerDirectory = path.join(this.workspace, "unverified_propositions", `prop-${workerId}`);
		const propositionFile = path.join(workerDirectory, "proposition.md");
		return completed(await this.runner({
			parent: this.parent,
			role: "generator",
			cwd: this.workspace,
			persona: "You are the AlphaSolve proposition filename generator. Return only the requested filename.",
			prompt: request.prompt,
			maxTurns: 1,
			signal: request.signal,
			permissionPolicy: createRolePolicy("generator", {
				workspace: this.workspace,
				workerDirectory,
				propositionFile
			}),
			modelSelection: this.modelSelection("generator"),
			allowedInheritedTools: []
		}), "proposition filename generator").text;
	};
	/** Fresh, read-only, non-nesting research review route for the orchestrator. */
	runResearchReview = async (request) => {
		throwIfAborted$1(request.signal);
		const task = request.prompt?.trim() || "Review the current verified research progress and recommend the next best-supported directions.";
		const definitions = createResearchReviewToolDefinitions(await createResearchReviewTools(this.workspace));
		const policy = createRolePolicy("research_reviewer", {
			workspace: this.workspace,
			extraAllowedTools: definitions.map((definition) => definition.name)
		});
		return (await this.runWithTrace({
			parent: this.parent,
			role: "research_reviewer",
			cwd: this.workspace,
			persona: loadRolePrompt("research_reviewer"),
			prompt: task,
			maxTurns: ROLE_MAX_TURNS.research_reviewer,
			signal: request.signal,
			permissionPolicy: policy,
			modelSelection: this.modelSelection("research_reviewer"),
			setupHelpers: (ctx) => {
				for (const definition of definitions) ctx.tools.register(definition);
			}
		}, {
			kind: "research_review",
			role: "research_reviewer",
			task,
			...request.workerId === void 0 ? {} : { workerId: request.workerId }
		})).result.text;
	};
	async curatorTaskPrompt(task) {
		if (task.kind === "health_check") return buildCuratorHealthCheckTask(typeof task.metadata?.scanText === "string" ? task.metadata.scanText : "");
		let trace = task.metadata === void 0 ? [] : [task.metadata];
		if (task.tracePath !== void 0) {
			const tracePath = await resolveWorkspacePath(this.workspace, task.tracePath, { mustExist: true });
			const decoded = JSON.parse(await readFile(tracePath, "utf8"));
			trace = Array.isArray(decoded) ? decoded : [decoded];
		}
		return buildCuratorDigestTask({
			traceKind: typeof task.metadata?.traceKind === "string" ? task.metadata.traceKind : task.kind,
			trace,
			callerContext: task.metadata ?? null,
			finalVerifierReview: task.kind === "verifier_final"
		});
	}
	/** DurableCurator-compatible runner; it deliberately never traces itself. */
	runCurator = async (context) => {
		throwIfAborted$1(context.signal);
		const task = await this.curatorTaskPrompt(context.task);
		const admitted = allowedSubagents("curator");
		const extraTools = [...CURATOR_TOOLS, ...admitted.length > 0 ? [SUBAGENT_TOOL_NAME] : []];
		const policy = createRolePolicy("curator", {
			workspace: this.workspace,
			extraAllowedTools: extraTools
		});
		completed(await this.runner({
			parent: this.parent,
			role: "curator",
			cwd: this.workspace,
			persona: loadRolePrompt("curator"),
			prompt: task,
			maxTurns: ROLE_MAX_TURNS.curator,
			signal: context.signal,
			permissionPolicy: policy,
			modelSelection: this.modelSelection("curator"),
			allowedInheritedTools: [],
			setupHelpers: (ctx, child, reportActivity = () => void 0) => {
				for (const tool of createCuratorTools(context.tools)) ctx.tools.register(tool);
				if (admitted.length > 0) ctx.tools.register(this.createSubagentTool("curator", void 0, child, policy, admitted, reportActivity));
			}
		}), `curator ${context.task.kind}`);
	};
};
/** Build the two AlphaSolve-main research navigation tools for one reviewer. */
function createResearchReviewToolDefinitions(tools) {
	return [jsonTool$1({
		name: RESEARCH_REVIEW_TOOL_NAMES.progress,
		description: [
			"Primary first-pass audit over problem.md, actual verified proposition Statements, and exploratory knowledge.",
			"Returns a program-ranked, globally budgeted research map rather than every file body: selected Statements, proof-tail conclusion signals, knowledge gaps, and suggested paths for deeper inspection.",
			"Treat verified Statements as authoritative; indexes and knowledge remain navigation or exploratory evidence. Call this before broad manual reads."
		].join("\n"),
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string" },
				paths: {
					type: "array",
					items: { type: "string" }
				},
				maxFiles: {
					type: "integer",
					minimum: 1,
					maximum: 500
				}
			}
		},
		outputSchema: { type: "object" },
		execute: async (args, exec) => {
			throwIfAborted$1(exec.signal);
			const record = argumentRecord$2(args, RESEARCH_REVIEW_TOOL_NAMES.progress);
			exactKeys$1(record, [
				"path",
				"paths",
				"maxFiles"
			], RESEARCH_REVIEW_TOOL_NAMES.progress);
			const requestedPath = optionalStringArgument(record, "path", RESEARCH_REVIEW_TOOL_NAMES.progress);
			let requestedPaths;
			if (record.paths !== void 0) {
				if (!Array.isArray(record.paths) || record.paths.some((item) => typeof item !== "string")) throw new TypeError(`${RESEARCH_REVIEW_TOOL_NAMES.progress}.paths must be a string array`);
				requestedPaths = record.paths;
			}
			const maxFiles = optionalIntegerArgument(record, "maxFiles", RESEARCH_REVIEW_TOOL_NAMES.progress);
			return tools.progressReview({
				...requestedPath === void 0 ? {} : { path: requestedPath },
				...requestedPaths === void 0 ? {} : { paths: requestedPaths },
				...maxFiles === void 0 ? {} : { maxFiles }
			});
		}
	}), jsonTool$1({
		name: RESEARCH_REVIEW_TOOL_NAMES.inspectMarkdown,
		description: ["Deepen the compact progress map on one selected Markdown path or directory.", "Returns headings, the relevant Statement/progress section, and the proof tail for a small bounded set of files. Use exact Read only after this narrows the required passage."].join("\n"),
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string" },
				maxFiles: {
					type: "integer",
					minimum: 1,
					maximum: 100
				},
				tailLines: {
					type: "integer",
					minimum: 1,
					maximum: 200
				},
				statementLines: {
					type: "integer",
					minimum: 1,
					maximum: 300
				}
			}
		},
		outputSchema: { type: "object" },
		execute: async (args, exec) => {
			throwIfAborted$1(exec.signal);
			const record = argumentRecord$2(args, RESEARCH_REVIEW_TOOL_NAMES.inspectMarkdown);
			exactKeys$1(record, [
				"path",
				"maxFiles",
				"tailLines",
				"statementLines"
			], RESEARCH_REVIEW_TOOL_NAMES.inspectMarkdown);
			const requestedPath = optionalStringArgument(record, "path", RESEARCH_REVIEW_TOOL_NAMES.inspectMarkdown);
			const maxFiles = optionalIntegerArgument(record, "maxFiles", RESEARCH_REVIEW_TOOL_NAMES.inspectMarkdown);
			const tailLines = optionalIntegerArgument(record, "tailLines", RESEARCH_REVIEW_TOOL_NAMES.inspectMarkdown);
			const statementLines = optionalIntegerArgument(record, "statementLines", RESEARCH_REVIEW_TOOL_NAMES.inspectMarkdown);
			return tools.inspectMarkdown(requestedPath, {
				...maxFiles === void 0 ? {} : { maxFiles },
				...tailLines === void 0 ? {} : { tailLines },
				...statementLines === void 0 ? {} : { statementLines }
			});
		}
	})];
}
/** Build the no-shell, knowledge-only tool surface for one curator invocation. */
function createCuratorTools(tools) {
	const read = jsonTool$1({
		name: CURATOR_TOOL_NAMES.read,
		description: "Read an exact line range from one file below knowledge/.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string" },
				startLine: { type: "integer" },
				endLine: { type: "integer" }
			},
			required: ["path"]
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string" },
				content: { type: "string" },
				startLine: { type: "integer" },
				endLine: { type: "integer" },
				totalLines: { type: "integer" }
			},
			required: [
				"path",
				"content",
				"startLine",
				"endLine",
				"totalLines"
			]
		},
		execute: async (args, exec) => {
			throwIfAborted$1(exec.signal);
			const record = argumentRecord$2(args, CURATOR_TOOL_NAMES.read);
			exactKeys$1(record, [
				"path",
				"startLine",
				"endLine"
			], CURATOR_TOOL_NAMES.read);
			const startLine = optionalIntegerArgument(record, "startLine", CURATOR_TOOL_NAMES.read);
			const endLine = optionalIntegerArgument(record, "endLine", CURATOR_TOOL_NAMES.read);
			return tools.read(stringArgument(record, "path", CURATOR_TOOL_NAMES.read), {
				...startLine === void 0 ? {} : { startLine },
				...endLine === void 0 ? {} : { endLine }
			});
		}
	});
	const write = jsonTool$1({
		name: CURATOR_TOOL_NAMES.write,
		description: "Create, overwrite, or append one knowledge file; references remain protected.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string" },
				content: { type: "string" },
				mode: {
					type: "string",
					enum: ["overwrite", "append"]
				}
			},
			required: ["path", "content"]
		},
		outputSchema: PATH_RESULT_SCHEMA,
		execute: async (args, exec) => {
			throwIfAborted$1(exec.signal);
			const record = argumentRecord$2(args, CURATOR_TOOL_NAMES.write);
			exactKeys$1(record, [
				"path",
				"content",
				"mode"
			], CURATOR_TOOL_NAMES.write);
			const mode = optionalStringArgument(record, "mode", CURATOR_TOOL_NAMES.write);
			if (mode !== void 0 && mode !== "overwrite" && mode !== "append") throw new TypeError(`${CURATOR_TOOL_NAMES.write}.mode is invalid`);
			return tools.write(stringArgument(record, "path", CURATOR_TOOL_NAMES.write), stringArgument(record, "content", CURATOR_TOOL_NAMES.write), mode === void 0 ? {} : { mode });
		}
	});
	const edit = jsonTool$1({
		name: CURATOR_TOOL_NAMES.edit,
		description: "Replace one unique exact text occurrence in a knowledge file.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string" },
				oldText: { type: "string" },
				newText: { type: "string" }
			},
			required: [
				"path",
				"oldText",
				"newText"
			]
		},
		outputSchema: PATH_RESULT_SCHEMA,
		execute: async (args, exec) => {
			throwIfAborted$1(exec.signal);
			const record = argumentRecord$2(args, CURATOR_TOOL_NAMES.edit);
			exactKeys$1(record, [
				"path",
				"oldText",
				"newText"
			], CURATOR_TOOL_NAMES.edit);
			return tools.edit(stringArgument(record, "path", CURATOR_TOOL_NAMES.edit), stringArgument(record, "oldText", CURATOR_TOOL_NAMES.edit), stringArgument(record, "newText", CURATOR_TOOL_NAMES.edit));
		}
	});
	const mkdir = jsonTool$1({
		name: CURATOR_TOOL_NAMES.mkdir,
		description: "Create one directory below knowledge/.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: { path: { type: "string" } },
			required: ["path"]
		},
		outputSchema: PATH_RESULT_SCHEMA,
		execute: async (args, exec) => {
			throwIfAborted$1(exec.signal);
			const record = argumentRecord$2(args, CURATOR_TOOL_NAMES.mkdir);
			exactKeys$1(record, ["path"], CURATOR_TOOL_NAMES.mkdir);
			return tools.mkdir(stringArgument(record, "path", CURATOR_TOOL_NAMES.mkdir));
		}
	});
	const rename = jsonTool$1({
		name: CURATOR_TOOL_NAMES.rename,
		description: "Rename one plain child name within a knowledge directory.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				directory: { type: "string" },
				oldName: { type: "string" },
				newName: { type: "string" }
			},
			required: [
				"directory",
				"oldName",
				"newName"
			]
		},
		outputSchema: PATH_RESULT_SCHEMA,
		execute: async (args, exec) => {
			throwIfAborted$1(exec.signal);
			const record = argumentRecord$2(args, CURATOR_TOOL_NAMES.rename);
			exactKeys$1(record, [
				"directory",
				"oldName",
				"newName"
			], CURATOR_TOOL_NAMES.rename);
			return tools.rename(stringArgument(record, "directory", CURATOR_TOOL_NAMES.rename), stringArgument(record, "oldName", CURATOR_TOOL_NAMES.rename), stringArgument(record, "newName", CURATOR_TOOL_NAMES.rename));
		}
	});
	const move = jsonTool$1({
		name: CURATOR_TOOL_NAMES.move,
		description: "Move one ordinary knowledge file into an existing knowledge directory.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string" },
				destinationDirectory: { type: "string" }
			},
			required: ["path", "destinationDirectory"]
		},
		outputSchema: PATH_RESULT_SCHEMA,
		execute: async (args, exec) => {
			throwIfAborted$1(exec.signal);
			const record = argumentRecord$2(args, CURATOR_TOOL_NAMES.move);
			exactKeys$1(record, ["path", "destinationDirectory"], CURATOR_TOOL_NAMES.move);
			return tools.move(stringArgument(record, "path", CURATOR_TOOL_NAMES.move), stringArgument(record, "destinationDirectory", CURATOR_TOOL_NAMES.move));
		}
	});
	const splitReference = jsonTool$1({
		name: CURATOR_TOOL_NAMES.splitReference,
		description: "Split a human reference by exact inclusive line ranges without rewriting it.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				sourcePath: { type: "string" },
				parts: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							path: { type: "string" },
							startLine: { type: "integer" },
							endLine: { type: "integer" }
						},
						required: [
							"path",
							"startLine",
							"endLine"
						]
					}
				}
			},
			required: ["sourcePath", "parts"]
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { paths: {
				type: "array",
				items: { type: "string" }
			} },
			required: ["paths"]
		},
		execute: async (args, exec) => {
			throwIfAborted$1(exec.signal);
			const record = argumentRecord$2(args, CURATOR_TOOL_NAMES.splitReference);
			exactKeys$1(record, ["sourcePath", "parts"], CURATOR_TOOL_NAMES.splitReference);
			if (!Array.isArray(record.parts)) throw new TypeError(`${CURATOR_TOOL_NAMES.splitReference}.parts must be an array`);
			const parts = record.parts.map((part, index) => {
				const value = argumentRecord$2(part, `${CURATOR_TOOL_NAMES.splitReference}.parts[${index}]`);
				exactKeys$1(value, [
					"path",
					"startLine",
					"endLine"
				], CURATOR_TOOL_NAMES.splitReference);
				const startLine = optionalIntegerArgument(value, "startLine", CURATOR_TOOL_NAMES.splitReference);
				const endLine = optionalIntegerArgument(value, "endLine", CURATOR_TOOL_NAMES.splitReference);
				if (startLine === void 0 || endLine === void 0) throw new TypeError(`${CURATOR_TOOL_NAMES.splitReference} part ranges are required`);
				return {
					path: stringArgument(value, "path", CURATOR_TOOL_NAMES.splitReference),
					startLine,
					endLine
				};
			});
			return tools.splitReference(stringArgument(record, "sourcePath", CURATOR_TOOL_NAMES.splitReference), parts);
		}
	});
	const remove = jsonTool$1({
		name: CURATOR_TOOL_NAMES.delete,
		description: "Delete one ordinary knowledge file or one empty knowledge directory.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: { path: { type: "string" } },
			required: ["path"]
		},
		outputSchema: PATH_RESULT_SCHEMA,
		execute: async (args, exec) => {
			throwIfAborted$1(exec.signal);
			const record = argumentRecord$2(args, CURATOR_TOOL_NAMES.delete);
			exactKeys$1(record, ["path"], CURATOR_TOOL_NAMES.delete);
			return tools.delete(stringArgument(record, "path", CURATOR_TOOL_NAMES.delete));
		}
	});
	const list = jsonTool$1({
		name: CURATOR_TOOL_NAMES.list,
		description: "List immediate entries in one knowledge directory.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: { path: { type: "string" } }
		},
		outputSchema: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string" },
					type: { type: "string" }
				},
				required: ["path", "type"]
			}
		},
		execute: async (args, exec) => {
			throwIfAborted$1(exec.signal);
			const record = argumentRecord$2(args, CURATOR_TOOL_NAMES.list);
			exactKeys$1(record, ["path"], CURATOR_TOOL_NAMES.list);
			return tools.list(optionalStringArgument(record, "path", CURATOR_TOOL_NAMES.list));
		}
	});
	const glob = jsonTool$1({
		name: CURATOR_TOOL_NAMES.glob,
		description: "Find knowledge files matching a restricted glob.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: { pattern: { type: "string" } },
			required: ["pattern"]
		},
		outputSchema: {
			type: "array",
			items: { type: "string" }
		},
		execute: async (args, exec) => {
			throwIfAborted$1(exec.signal);
			const record = argumentRecord$2(args, CURATOR_TOOL_NAMES.glob);
			exactKeys$1(record, ["pattern"], CURATOR_TOOL_NAMES.glob);
			return tools.glob(stringArgument(record, "pattern", CURATOR_TOOL_NAMES.glob));
		}
	});
	const grep = jsonTool$1({
		name: CURATOR_TOOL_NAMES.grep,
		description: "Search text below knowledge/ with bounded results.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				query: { type: "string" },
				path: { type: "string" },
				caseSensitive: { type: "boolean" },
				maxResults: { type: "integer" }
			},
			required: ["query"]
		},
		outputSchema: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string" },
					line: { type: "integer" },
					text: { type: "string" }
				},
				required: [
					"path",
					"line",
					"text"
				]
			}
		},
		execute: async (args, exec) => {
			throwIfAborted$1(exec.signal);
			const record = argumentRecord$2(args, CURATOR_TOOL_NAMES.grep);
			exactKeys$1(record, [
				"query",
				"path",
				"caseSensitive",
				"maxResults"
			], CURATOR_TOOL_NAMES.grep);
			const grepPath = optionalStringArgument(record, "path", CURATOR_TOOL_NAMES.grep);
			const caseSensitive = optionalBooleanArgument(record, "caseSensitive", CURATOR_TOOL_NAMES.grep);
			const maxResults = optionalIntegerArgument(record, "maxResults", CURATOR_TOOL_NAMES.grep);
			return tools.grep(stringArgument(record, "query", CURATOR_TOOL_NAMES.grep), {
				...grepPath === void 0 ? {} : { path: grepPath },
				...caseSensitive === void 0 ? {} : { caseSensitive },
				...maxResults === void 0 ? {} : { maxResults }
			});
		}
	});
	return Object.freeze([
		read,
		write,
		edit,
		mkdir,
		rename,
		move,
		splitReference,
		remove,
		list,
		glob,
		grep
	]);
}
//#endregion
//#region src/store.ts
/** Durable AlphaSolve state, worker records, and exactly-once completion ledger. */
/** Serialize asynchronous state transactions inside one workspace-owning runtime. */
var AsyncMutex = class {
	tail = Promise.resolve();
	async run(operation) {
		const previous = this.tail;
		const gate = Promise.withResolvers();
		this.tail = previous.then(() => gate.promise);
		await previous;
		try {
			return await operation();
		} finally {
			gate.resolve();
		}
	}
};
function expectExactKeys(value, allowed, path) {
	const extras = Object.keys(value).filter((key) => !allowed.includes(key));
	if (extras.length > 0) throw new DurableDataError(`unknown fields: ${extras.join(", ")}`, path);
}
function expectString(value, field, path) {
	if (typeof value !== "string" || value === "") throw new DurableDataError(`field ${field} must be a non-empty string`, path);
	return value;
}
function expectOptionalString(value, field, path) {
	return value === void 0 ? void 0 : expectString(value, field, path);
}
function expectIsoDate(value, field, path) {
	const text = expectString(value, field, path);
	if (Number.isNaN(Date.parse(text))) throw new DurableDataError(`field ${field} must be an ISO date`, path);
	return text;
}
function requireCallId(callId) {
	if (typeof callId !== "string" || callId.trim() === "") throw new TypeError("callId must not be empty");
}
function requireWorkerId(workerId) {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workerId)) throw new TypeError(`invalid worker id: ${workerId}`);
}
function requireTracePath(tracePath) {
	const normalized = normalizeRelativePath(tracePath);
	if (normalized !== tracePath || !normalized.startsWith(".alphasolve/traces/")) throw new TypeError(`trace artifact must be a canonical path below .alphasolve/traces/: ${tracePath}`);
	return normalized;
}
function parseTraceManifest(value, manifestPath, workerId) {
	expectExactKeys(value, [
		"version",
		"workerId",
		"paths"
	], manifestPath);
	if (value.version !== 1) throw new DurableDataError("unsupported trace-manifest version", manifestPath);
	if (value.workerId !== workerId) throw new DurableDataError("trace manifest worker id does not match", manifestPath);
	if (!Array.isArray(value.paths) || value.paths.some((item) => typeof item !== "string")) throw new DurableDataError("trace manifest paths must be a string array", manifestPath);
	let paths;
	try {
		paths = value.paths.map((item) => requireTracePath(item));
	} catch (error) {
		throw new DurableDataError("trace manifest contains an invalid path", manifestPath, { cause: error });
	}
	if (new Set(paths).size !== paths.length) throw new DurableDataError("trace manifest contains duplicate paths", manifestPath);
	return {
		version: 1,
		workerId,
		paths
	};
}
function expectPositiveInteger(value, field, path) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new DurableDataError(`field ${field} must be a positive safe integer`, path);
	return value;
}
function expectNonNegativeInteger(value, field, path) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new DurableDataError(`field ${field} must be a non-negative safe integer`, path);
	return value;
}
function parseModelOverrides(value, path) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DurableDataError("modelOverrides must be an object", path);
	const object = value;
	expectExactKeys(object, MODEL_ROLES, path);
	const result = {};
	for (const role of MODEL_ROLES) {
		const candidate = object[role];
		if (candidate === void 0) continue;
		if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new DurableDataError(`modelOverrides.${role} must be an object`, path);
		const fields = candidate;
		expectExactKeys(fields, [
			"provider",
			"model",
			"reasoningEffort"
		], path);
		const override = {};
		if (fields.provider !== void 0) override.provider = expectString(fields.provider, `${role}.provider`, path);
		if (fields.model !== void 0) override.model = expectString(fields.model, `${role}.model`, path);
		if (fields.reasoningEffort !== void 0) override.reasoningEffort = expectString(fields.reasoningEffort, `${role}.reasoningEffort`, path);
		result[role] = override;
	}
	return result;
}
/** Parse persisted session state and reject corruption or a future format. */
function parseSessionState(value, path) {
	expectExactKeys(value, [
		"version",
		"sessionId",
		"workspace",
		"activatedAt",
		"updatedAt",
		"status",
		"problemDigest",
		"hintDigest",
		"notifiedHintDigest",
		"capacity",
		"detailedTrace",
		"modelOverrides",
		"nextCompletionSequence",
		"winnerWorkerId"
	], path);
	if (value.version !== 1) throw new DurableDataError("unsupported state version", path);
	if (![
		"active",
		"stopping",
		"interrupted",
		"solved"
	].includes(String(value.status))) throw new DurableDataError("invalid runtime status", path);
	if (typeof value.detailedTrace !== "boolean") throw new DurableDataError("detailedTrace must be boolean", path);
	return {
		version: 1,
		sessionId: expectString(value.sessionId, "sessionId", path),
		workspace: expectString(value.workspace, "workspace", path),
		activatedAt: expectIsoDate(value.activatedAt, "activatedAt", path),
		updatedAt: expectIsoDate(value.updatedAt, "updatedAt", path),
		status: value.status,
		problemDigest: expectString(value.problemDigest, "problemDigest", path),
		capacity: expectPositiveInteger(value.capacity, "capacity", path),
		detailedTrace: value.detailedTrace,
		modelOverrides: parseModelOverrides(value.modelOverrides, path),
		nextCompletionSequence: expectPositiveInteger(value.nextCompletionSequence, "nextCompletionSequence", path),
		...expectOptionalString(value.hintDigest, "hintDigest", path) === void 0 ? {} : { hintDigest: value.hintDigest },
		...expectOptionalString(value.notifiedHintDigest, "notifiedHintDigest", path) === void 0 ? {} : { notifiedHintDigest: value.notifiedHintDigest },
		...expectOptionalString(value.winnerWorkerId, "winnerWorkerId", path) === void 0 ? {} : { winnerWorkerId: value.winnerWorkerId }
	};
}
/** Parse enough completion fields to make wait delivery fail closed. */
function parseCompletion(value, path) {
	expectExactKeys(value, [
		"version",
		"sequence",
		"workerId",
		"status",
		"startedAt",
		"completedAt",
		"problemDigest",
		"hintDigest",
		"producedVerifiedProposition",
		"solved",
		"summary",
		"statement",
		"propositionPath",
		"failureStage",
		"reason",
		"artifactPaths",
		"reservedByCallId",
		"deliveredByCallId",
		"deliveredAt"
	], path);
	if (value.version !== 1) throw new DurableDataError("unsupported completion version", path);
	if (![
		"verified",
		"solved",
		"rejected",
		"failed",
		"cancelled",
		"interrupted",
		"stale_problem",
		"write_conflict",
		"discarded_after_solution"
	].includes(String(value.status))) throw new DurableDataError("invalid completion status", path);
	if (typeof value.producedVerifiedProposition !== "boolean" || typeof value.solved !== "boolean") throw new DurableDataError("completion booleans are invalid", path);
	if (!Array.isArray(value.artifactPaths) || value.artifactPaths.some((item) => typeof item !== "string")) throw new DurableDataError("artifactPaths must be a string array", path);
	const reservedByCallId = expectOptionalString(value.reservedByCallId, "reservedByCallId", path);
	const deliveredByCallId = expectOptionalString(value.deliveredByCallId, "deliveredByCallId", path);
	const deliveredAt = expectOptionalString(value.deliveredAt, "deliveredAt", path);
	if (deliveredByCallId === void 0 !== (deliveredAt === void 0)) throw new DurableDataError("deliveredByCallId and deliveredAt must be present together", path);
	if (deliveredByCallId !== void 0 && deliveredByCallId !== reservedByCallId) throw new DurableDataError("delivered completion must retain the matching reservation call id", path);
	if (deliveredAt !== void 0) expectIsoDate(deliveredAt, "deliveredAt", path);
	return {
		version: 1,
		sequence: expectPositiveInteger(value.sequence, "sequence", path),
		workerId: expectString(value.workerId, "workerId", path),
		status: value.status,
		startedAt: expectIsoDate(value.startedAt, "startedAt", path),
		completedAt: expectIsoDate(value.completedAt, "completedAt", path),
		problemDigest: expectString(value.problemDigest, "problemDigest", path),
		producedVerifiedProposition: value.producedVerifiedProposition,
		solved: value.solved,
		summary: expectString(value.summary, "summary", path),
		artifactPaths: value.artifactPaths,
		...expectOptionalString(value.hintDigest, "hintDigest", path) === void 0 ? {} : { hintDigest: value.hintDigest },
		...expectOptionalString(value.statement, "statement", path) === void 0 ? {} : { statement: value.statement },
		...expectOptionalString(value.propositionPath, "propositionPath", path) === void 0 ? {} : { propositionPath: value.propositionPath },
		...expectOptionalString(value.failureStage, "failureStage", path) === void 0 ? {} : { failureStage: value.failureStage },
		...expectOptionalString(value.reason, "reason", path) === void 0 ? {} : { reason: value.reason },
		...reservedByCallId === void 0 ? {} : { reservedByCallId },
		...deliveredByCallId === void 0 ? {} : { deliveredByCallId },
		...deliveredAt === void 0 ? {} : { deliveredAt }
	};
}
/** Parse a worker snapshot strictly before recovery mutates or reports it. */
function parseWorkerRecord(value, path) {
	expectExactKeys(value, [
		"version",
		"id",
		"instruction",
		"phase",
		"terminalStatus",
		"createdAt",
		"updatedAt",
		"completedAt",
		"problemDigest",
		"hintDigest",
		"round",
		"verifierProfile",
		"theoremChecks",
		"propositionPath",
		"verifiedPath",
		"statement",
		"summary",
		"failureStage",
		"reason",
		"artifactPaths"
	], path);
	if (value.version !== 1) throw new DurableDataError("unsupported worker version", path);
	const phases = [
		"created",
		"generator",
		"verifier",
		"reviser",
		"theorem_checker",
		"arbitrating",
		"promoting",
		"complete"
	];
	const statuses = [
		"verified",
		"solved",
		"rejected",
		"failed",
		"cancelled",
		"interrupted",
		"stale_problem",
		"write_conflict",
		"discarded_after_solution"
	];
	if (typeof value.phase !== "string" || !phases.includes(value.phase)) throw new DurableDataError("invalid worker phase", path);
	if (value.terminalStatus !== void 0 && (typeof value.terminalStatus !== "string" || !statuses.includes(value.terminalStatus))) throw new DurableDataError("invalid worker terminalStatus", path);
	if (value.verifierProfile !== void 0 && (typeof value.verifierProfile !== "string" || !VERIFIER_PROFILES.includes(value.verifierProfile))) throw new DurableDataError("invalid worker verifierProfile", path);
	if (!Array.isArray(value.artifactPaths) || value.artifactPaths.some((item) => typeof item !== "string")) throw new DurableDataError("worker artifactPaths must be a string array", path);
	return {
		version: 1,
		id: expectString(value.id, "id", path),
		...expectOptionalString(value.instruction, "instruction", path) === void 0 ? {} : { instruction: value.instruction },
		phase: value.phase,
		...value.terminalStatus === void 0 ? {} : { terminalStatus: value.terminalStatus },
		createdAt: expectIsoDate(value.createdAt, "createdAt", path),
		updatedAt: expectIsoDate(value.updatedAt, "updatedAt", path),
		...value.completedAt === void 0 ? {} : { completedAt: expectIsoDate(value.completedAt, "completedAt", path) },
		problemDigest: expectString(value.problemDigest, "problemDigest", path),
		...expectOptionalString(value.hintDigest, "hintDigest", path) === void 0 ? {} : { hintDigest: value.hintDigest },
		round: expectNonNegativeInteger(value.round, "round", path),
		...value.verifierProfile === void 0 ? {} : { verifierProfile: value.verifierProfile },
		theoremChecks: expectNonNegativeInteger(value.theoremChecks, "theoremChecks", path),
		...expectOptionalString(value.propositionPath, "propositionPath", path) === void 0 ? {} : { propositionPath: value.propositionPath },
		...expectOptionalString(value.verifiedPath, "verifiedPath", path) === void 0 ? {} : { verifiedPath: value.verifiedPath },
		...expectOptionalString(value.statement, "statement", path) === void 0 ? {} : { statement: value.statement },
		...expectOptionalString(value.summary, "summary", path) === void 0 ? {} : { summary: value.summary },
		...expectOptionalString(value.failureStage, "failureStage", path) === void 0 ? {} : { failureStage: value.failureStage },
		...expectOptionalString(value.reason, "reason", path) === void 0 ? {} : { reason: value.reason },
		artifactPaths: value.artifactPaths
	};
}
/** Persistent storage owned by one locked AlphaSolve session runtime. */
var RuntimeStore = class {
	workspace;
	mutex = new AsyncMutex();
	statePath;
	workerDir;
	completionDir;
	state;
	constructor(workspace) {
		this.workspace = workspace;
		this.statePath = resolveWorkspacePath(workspace, ".alphasolve/state.json", { mustExist: false });
		this.workerDir = resolveWorkspacePath(workspace, ".alphasolve/workers", { mustExist: true });
		this.completionDir = resolveWorkspacePath(workspace, ".alphasolve/completions", { mustExist: true });
	}
	/** Initialize fresh state or load and reconcile an interrupted state. */
	async open(initial) {
		return this.mutex.run(async () => {
			const statePath = await this.statePath;
			let state;
			let resumed = false;
			try {
				state = parseSessionState(await readJsonObject(statePath), statePath);
				resumed = true;
			} catch (error) {
				const causeCode = error.cause?.code;
				if (!(error instanceof DurableDataError) || causeCode !== "ENOENT") throw error;
				state = initial;
			}
			const maxSequence = (await this.readCompletionsUnlocked()).reduce((maximum, item) => Math.max(maximum, item.sequence), 0);
			if (state.nextCompletionSequence <= maxSequence || state.status === "stopping") state = {
				...state,
				status: state.status === "solved" ? "solved" : "interrupted",
				nextCompletionSequence: Math.max(state.nextCompletionSequence, maxSequence + 1),
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			this.state = state;
			await atomicWriteJson(statePath, state);
			return {
				state,
				resumed
			};
		});
	}
	/** Return the in-memory state only after {@link open}. */
	currentState() {
		if (this.state === void 0) throw new Error("RuntimeStore.open() has not completed");
		return this.state;
	}
	/** Atomically update the session state inside this runtime. */
	async updateState(update) {
		return this.mutex.run(async () => {
			const next = update(this.currentState());
			this.state = {
				...next,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			await atomicWriteJson(await this.statePath, this.state);
			return this.state;
		});
	}
	/** Persist a complete worker snapshot. */
	async writeWorker(record) {
		await atomicWriteJson(await resolveWorkspacePath(this.workspace, `.alphasolve/workers/${record.id}.json`, { mustExist: false }), record);
	}
	async traceManifestPath(workerId) {
		requireWorkerId(workerId);
		return resolveWorkspacePath(this.workspace, `.alphasolve/traces/worker-${workerId}-manifest.json`, { mustExist: false });
	}
	/** Append one already-persisted trace path to a durable per-worker manifest. */
	async appendWorkerTracePath(workerId, tracePath) {
		const normalized = requireTracePath(tracePath);
		await resolveWorkspacePath(this.workspace, normalized, { mustExist: true });
		await this.mutex.run(async () => {
			const manifestPath = await this.traceManifestPath(workerId);
			let manifest = {
				version: 1,
				workerId,
				paths: []
			};
			try {
				const info = await lstat(manifestPath);
				if (!info.isFile() || info.isSymbolicLink()) throw new DurableDataError("trace manifest is not an ordinary file", manifestPath);
				manifest = parseTraceManifest(await readJsonObject(manifestPath), manifestPath, workerId);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			if (manifest.paths.includes(normalized)) return;
			await atomicWriteJson(manifestPath, {
				...manifest,
				paths: [...manifest.paths, normalized]
			});
		});
	}
	/** Read the durable trace manifest used by normal completion and crash recovery. */
	async listWorkerTracePaths(workerId) {
		return this.mutex.run(async () => {
			const manifestPath = await this.traceManifestPath(workerId);
			try {
				const info = await lstat(manifestPath);
				if (!info.isFile() || info.isSymbolicLink()) throw new DurableDataError("trace manifest is not an ordinary file", manifestPath);
			} catch (error) {
				if (error.code === "ENOENT") return [];
				throw error;
			}
			return parseTraceManifest(await readJsonObject(manifestPath), manifestPath, workerId).paths;
		});
	}
	/**
	* Convert crash-left worker snapshots into interrupted terminal records and
	* publish any terminal record whose completion write never happened.
	*/
	async recoverInterruptedWorkers() {
		const directory = await this.workerDir;
		const entries = await readdir(directory, { withFileTypes: true });
		const existing = new Set((await this.listCompletions()).map((item) => item.workerId));
		const recovered = [];
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (!entry.name.endsWith(".json")) continue;
			const relativePath = `.alphasolve/workers/${entry.name}`;
			const workerPath = await resolveWorkspacePath(this.workspace, relativePath, { mustExist: true });
			if (!entry.isFile()) throw new DurableDataError("worker entry is not an ordinary file", workerPath);
			let worker = parseWorkerRecord(await readJsonObject(workerPath), workerPath);
			if (`${worker.id}.json` !== entry.name) throw new DurableDataError("worker filename does not match worker id", workerPath);
			if (worker.terminalStatus === void 0) {
				const completedAt = (/* @__PURE__ */ new Date()).toISOString();
				worker = {
					...worker,
					phase: "complete",
					terminalStatus: "interrupted",
					updatedAt: completedAt,
					completedAt,
					failureStage: worker.phase,
					reason: "worker was active when the prior AlphaSolve runtime ended"
				};
				await atomicWriteJson(workerPath, worker);
			}
			if (existing.has(worker.id)) continue;
			const status = worker.terminalStatus;
			if (status === void 0) throw new DurableDataError("worker recovery did not produce a terminal status", workerPath);
			const tracePaths = await this.listWorkerTracePaths(worker.id);
			const completion = await this.recordCompletion({
				workerId: worker.id,
				status,
				startedAt: worker.createdAt,
				completedAt: worker.completedAt ?? worker.updatedAt,
				problemDigest: worker.problemDigest,
				...worker.hintDigest === void 0 ? {} : { hintDigest: worker.hintDigest },
				producedVerifiedProposition: worker.verifiedPath !== void 0 || status === "verified" || status === "solved",
				solved: status === "solved" || status === "discarded_after_solution",
				summary: worker.summary ?? worker.reason ?? worker.statement ?? `worker ended with status ${status}`,
				...worker.statement === void 0 ? {} : { statement: worker.statement },
				...worker.verifiedPath === void 0 ? {} : { propositionPath: worker.verifiedPath },
				...worker.failureStage === void 0 ? {} : { failureStage: worker.failureStage },
				...worker.reason === void 0 ? {} : { reason: worker.reason },
				artifactPaths: [.../* @__PURE__ */ new Set([...worker.artifactPaths, ...tracePaths])]
			});
			existing.add(worker.id);
			recovered.push(completion);
		}
		return recovered;
	}
	/**
	* Strictly read every worker snapshot without applying recovery mutations.
	* Generation archival calls this before moving any durable ledger so a
	* malformed entry can never be silently hidden in a backup.
	*/
	async validateWorkers() {
		const directory = await this.workerDir;
		const entries = await readdir(directory, { withFileTypes: true });
		const workers = [];
		const ids = /* @__PURE__ */ new Set();
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (!entry.name.endsWith(".json")) continue;
			const relativePath = `.alphasolve/workers/${entry.name}`;
			const workerPath = await resolveWorkspacePath(this.workspace, relativePath, { mustExist: true });
			if (!entry.isFile()) throw new DurableDataError("worker entry is not an ordinary file", workerPath);
			const worker = parseWorkerRecord(await readJsonObject(workerPath), workerPath);
			if (`${worker.id}.json` !== entry.name) throw new DurableDataError("worker filename does not match worker id", workerPath);
			if (ids.has(worker.id)) throw new DurableDataError("duplicate worker id", workerPath);
			ids.add(worker.id);
			workers.push(worker);
		}
		return workers;
	}
	/**
	* Reconcile the crash windows around a provisional winner claim.
	*
	* A solution is terminal only when both the unique durable winner
	* completion and the atomically-published complete solution are present.
	* A claim (including the earlier state=solved-before-completion window) with
	* no winner completion is provisional and is cleared so a fresh worker can
	* win. Conversely, a completion written just before a state update repairs
	* state to solved. A winner completion whose solution disappeared is
	* durable corruption and must fail closed rather than be delivered as
	* solved or silently rewritten.
	*/
	async reconcileSolvedTerminal(solutionComplete) {
		return this.mutex.run(async () => {
			const completions = await this.readCompletionsUnlocked();
			const state = this.currentState();
			const winners = completions.filter((completion) => completion.problemDigest === state.problemDigest && completion.status === "solved" && completion.solved);
			if (winners.length > 1) throw new DurableDataError("multiple solved winner completions exist", await this.completionDir);
			const winner = winners[0];
			if (winner !== void 0) {
				if (!solutionComplete) throw new DurableDataError(`solved completion ${winner.workerId} has no complete solution.md`, await this.completionDir);
				if (state.status !== "solved" || state.winnerWorkerId !== winner.workerId) {
					this.state = {
						...state,
						status: "solved",
						winnerWorkerId: winner.workerId,
						updatedAt: (/* @__PURE__ */ new Date()).toISOString()
					};
					await atomicWriteJson(await this.statePath, this.state);
				}
				return winner;
			}
			if (state.winnerWorkerId !== void 0 || state.status === "solved") {
				const { winnerWorkerId: _provisional, ...withoutWinner } = state;
				this.state = {
					...withoutWinner,
					status: state.status === "solved" ? "interrupted" : state.status,
					updatedAt: (/* @__PURE__ */ new Date()).toISOString()
				};
				await atomicWriteJson(await this.statePath, this.state);
			}
		});
	}
	/** Assign a durable sequence and publish a worker completion before notifying waiters. */
	async recordCompletion(completion) {
		return this.mutex.run(async () => {
			const state = this.currentState();
			const value = {
				version: 1,
				sequence: state.nextCompletionSequence,
				...completion
			};
			const path = await resolveWorkspacePath(this.workspace, `.alphasolve/completions/${value.workerId}.json`, { mustExist: false });
			const validated = parseCompletion(value, path);
			if (`${validated.workerId}.json` !== path.split(/[\\/]/).at(-1)) throw new DurableDataError("completion workerId is not a safe filename", path);
			try {
				await lstat(path);
				throw new DurableDataError(`completion already exists for worker ${value.workerId}`, path);
			} catch (error) {
				if (error instanceof DurableDataError) throw error;
				if (error.code !== "ENOENT") throw error;
			}
			await atomicWriteJson(path, validated);
			this.state = {
				...state,
				nextCompletionSequence: state.nextCompletionSequence + 1,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			await atomicWriteJson(await this.statePath, this.state);
			return validated;
		});
	}
	async readCompletionsUnlocked() {
		const dir = await this.completionDir;
		const entries = await readdir(dir, { withFileTypes: true });
		const completions = [];
		const sequences = /* @__PURE__ */ new Set();
		for (const entry of entries) {
			if (!entry.name.endsWith(".json")) continue;
			const relativePath = `.alphasolve/completions/${entry.name}`;
			const path = await resolveWorkspacePath(this.workspace, relativePath, { mustExist: true });
			if (!entry.isFile()) throw new DurableDataError("completion entry is not an ordinary file", path);
			const completion = parseCompletion(await readJsonObject(path), path);
			if (`${completion.workerId}.json` !== entry.name) throw new DurableDataError("completion filename does not match workerId", path);
			if (sequences.has(completion.sequence)) throw new DurableDataError("duplicate completion sequence", path);
			sequences.add(completion.sequence);
			completions.push(completion);
		}
		return completions.sort((left, right) => left.sequence - right.sequence);
	}
	/** List all completion ledger entries in publication order. */
	async listCompletions() {
		return this.mutex.run(() => this.readCompletionsUnlocked());
	}
	/** Reserve every currently undelivered completion for one wait tool call. */
	async reserveUndelivered(callId) {
		requireCallId(callId);
		return this.mutex.run(async () => {
			const selected = (await this.readCompletionsUnlocked()).filter((entry) => entry.deliveredByCallId === void 0 && (entry.reservedByCallId === void 0 || entry.reservedByCallId === callId));
			const reserved = [];
			for (const entry of selected) {
				const next = {
					...entry,
					reservedByCallId: callId
				};
				await atomicWriteJson(await resolveWorkspacePath(this.workspace, `.alphasolve/completions/${entry.workerId}.json`, { mustExist: true }), next);
				reserved.push(next);
			}
			return reserved;
		});
	}
	/** Commit delivery only after DSH records the authoritative tool result. */
	async commitDelivery(callId) {
		requireCallId(callId);
		await this.mutex.run(async () => {
			const entries = await this.readCompletionsUnlocked();
			for (const entry of entries.filter((item) => item.reservedByCallId === callId && item.deliveredByCallId === void 0)) {
				const next = {
					...entry,
					deliveredByCallId: callId,
					deliveredAt: (/* @__PURE__ */ new Date()).toISOString()
				};
				await atomicWriteJson(await resolveWorkspacePath(this.workspace, `.alphasolve/completions/${entry.workerId}.json`, { mustExist: true }), next);
			}
		});
	}
	/** Release a wait reservation whose result never reached the durable session. */
	async releaseReservation(callId) {
		requireCallId(callId);
		await this.mutex.run(async () => {
			const entries = await this.readCompletionsUnlocked();
			for (const entry of entries.filter((item) => item.reservedByCallId === callId && item.deliveredByCallId === void 0)) {
				const { reservedByCallId: _ignored, ...next } = entry;
				await atomicWriteJson(await resolveWorkspacePath(this.workspace, `.alphasolve/completions/${entry.workerId}.json`, { mustExist: true }), next);
			}
		});
	}
	/** Reconcile crash-stuck reservations against tool results already present in the session log. */
	async recoverReservations(committedCallIds) {
		await this.mutex.run(async () => {
			const entries = await this.readCompletionsUnlocked();
			for (const entry of entries) {
				if (entry.reservedByCallId === void 0 || entry.deliveredByCallId !== void 0) continue;
				const path = await resolveWorkspacePath(this.workspace, `.alphasolve/completions/${entry.workerId}.json`, { mustExist: true });
				if (committedCallIds.has(entry.reservedByCallId)) await atomicWriteJson(path, {
					...entry,
					deliveredByCallId: entry.reservedByCallId,
					deliveredAt: (/* @__PURE__ */ new Date()).toISOString()
				});
				else {
					const { reservedByCallId: _ignored, ...next } = entry;
					await atomicWriteJson(path, next);
				}
			}
		});
	}
};
//#endregion
//#region src/worker-manager.ts
/** Capacity-bounded asynchronous worker scheduling and durable wait delivery. */
/** Thrown at workflow phase boundaries when the immutable problem changed. */
var ProblemChangedError = class extends Error {
	constructor() {
		super("problem.md changed after AlphaSolve activation");
		this.name = "ProblemChangedError";
	}
};
function summarizeCompletion(result) {
	if (result.solved) return result.statement === void 0 ? "worker produced the accepted solution" : `worker produced the accepted solution: ${result.statement}`;
	if (result.status === "failed") {
		const prefix = result.producedVerifiedProposition ? "worker produced a verified proposition, but the workflow failed" : "worker workflow failed";
		const stage = result.failureStage === void 0 ? "" : ` at ${result.failureStage}`;
		return result.reason === void 0 ? `${prefix}${stage}` : `${prefix}${stage}: ${result.reason}`;
	}
	if (result.producedVerifiedProposition) return result.statement === void 0 ? "worker produced a verified proposition" : `worker produced a verified proposition: ${result.statement}`;
	if (result.reason !== void 0) return result.reason;
	return `worker ended with status ${result.status}`;
}
/** A notifier whose monotonically increasing generation closes check/wait races. */
var CompletionNotifier = class {
	generation = 0;
	waiters = /* @__PURE__ */ new Set();
	current() {
		return this.generation;
	}
	notify() {
		this.generation += 1;
		const waiters = [...this.waiters];
		this.waiters.clear();
		for (const resolve of waiters) resolve();
	}
	async waitAfter(generation, signal) {
		if (this.generation !== generation) return;
		if (signal.aborted) throw signal.reason ?? new DOMException("wait cancelled", "AbortError");
		const deferred = Promise.withResolvers();
		const settle = () => deferred.resolve();
		const abort = () => deferred.reject(signal.reason ?? new DOMException("wait cancelled", "AbortError"));
		this.waiters.add(settle);
		signal.addEventListener("abort", abort, { once: true });
		try {
			if (this.generation !== generation) settle();
			await deferred.promise;
		} finally {
			this.waiters.delete(settle);
			signal.removeEventListener("abort", abort);
		}
	}
};
async function waitWithAbort(promise, signal) {
	if (signal.aborted) throw signal.reason ?? new DOMException("wait cancelled", "AbortError");
	const aborted = Promise.withResolvers();
	const abort = () => aborted.reject(signal.reason ?? new DOMException("wait cancelled", "AbortError"));
	signal.addEventListener("abort", abort, { once: true });
	try {
		await Promise.race([promise, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
/** Own all detached worker promises for exactly one active AlphaSolve session. */
var WorkerManager = class {
	store;
	executeWorkflow;
	onHintChanged;
	onBackgroundError;
	assertRuntimeOwned;
	onSolution;
	active = /* @__PURE__ */ new Map();
	activeRecords = /* @__PURE__ */ new Map();
	notifier = new CompletionNotifier();
	pendingAdmissions = /* @__PURE__ */ new Set();
	stopping = false;
	solutionFound = false;
	finalizingWinnerId;
	solutionDrainGate;
	stopStatus = "interrupted";
	problemNoticeSent = false;
	constructor(store, executeWorkflow, onHintChanged, onBackgroundError = () => {}, assertRuntimeOwned = async () => void 0, onSolution = async () => void 0) {
		this.store = store;
		this.executeWorkflow = executeWorkflow;
		this.onHintChanged = onHintChanged;
		this.onBackgroundError = onBackgroundError;
		this.assertRuntimeOwned = assertRuntimeOwned;
		this.onSolution = onSolution;
		this.solutionFound = store.currentState().status === "solved";
	}
	/** Current active worker IDs in start order. */
	activeIds() {
		return [...this.active.keys()];
	}
	/** Synchronous model/UI summary updated at every durable phase boundary. */
	activeProgress() {
		return [...this.activeRecords.values()].map((record) => ({
			workerId: record.id,
			phase: record.phase,
			round: record.round,
			...record.verifierProfile === void 0 ? {} : { verifierProfile: record.verifierProfile },
			theoremChecks: record.theoremChecks
		}));
	}
	/** Current hard capacity from durable session state. */
	capacity() {
		return this.store.currentState().capacity;
	}
	/** Whether active work temporarily exceeds a newly lowered capacity. */
	overCapacity() {
		return this.active.size > this.capacity();
	}
	/** Verify problem/hint digests and notify the orchestrator once per hint version. */
	async assertInputsCurrent() {
		await this.assertRuntimeOwned();
		const state = this.store.currentState();
		if ((await readWorkspaceInput(this.store.workspace, "problem.md", { nonEmpty: true })).digest !== state.problemDigest) {
			if (!this.problemNoticeSent) {
				this.problemNoticeSent = true;
				this.onHintChanged([
					"AlphaSolve notice: problem.md changed after activation.",
					"New workers are blocked and old-digest results will never be promoted or used to write solution.md.",
					"Ask the user to choose explicitly: (1) restore the activation-time problem; (2) begin a new problem generation by stopping this runtime, then making a new explicit AlphaSolve solve request; or (3) accept old-generation results only as non-promoted research context."
				].join(" "));
			}
			throw new ProblemChangedError();
		}
		const hintDigest = await workspaceFileExists(this.store.workspace, "hint.md") ? (await readWorkspaceInput(this.store.workspace, "hint.md", { nonEmpty: false })).digest : void 0;
		const noticeKey = hintDigest ?? "<missing>";
		let notice;
		await this.store.updateState((current) => {
			if (current.hintDigest === hintDigest) return current;
			if (current.notifiedHintDigest !== noticeKey) notice = hintDigest === void 0 ? "AlphaSolve notice: hint.md was removed after activation; future workers will use no general hint." : "AlphaSolve notice: hint.md changed after activation; future workers will use the new contents.";
			if (hintDigest === void 0) {
				const { hintDigest: _oldHint, ...withoutHint } = current;
				return {
					...withoutHint,
					notifiedHintDigest: noticeKey
				};
			}
			return {
				...current,
				hintDigest,
				notifiedHintDigest: noticeKey
			};
		});
		if (notice !== void 0) this.onHintChanged(notice);
	}
	/** Atomically claim the one solution winner. */
	async claimSolvedWinner(workerId) {
		let claimed = false;
		await this.store.updateState((state) => {
			if (state.winnerWorkerId !== void 0) return state;
			claimed = true;
			return {
				...state,
				winnerWorkerId: workerId
			};
		});
		if (claimed) {
			this.finalizingWinnerId = workerId;
			this.solutionFound = true;
			this.solutionDrainGate = Promise.withResolvers();
			for (const worker of this.active.values()) if (worker.id !== workerId) worker.controller.abort(/* @__PURE__ */ new Error("another worker is finalizing the solution"));
			this.notifier.notify();
		}
		return claimed;
	}
	/** Release only this worker's provisional winner claim after a failed publish. */
	async releaseSolvedWinner(workerId) {
		let released = false;
		await this.store.updateState((state) => {
			if (state.winnerWorkerId !== workerId || state.status === "solved") return state;
			released = true;
			const { winnerWorkerId: _winner, ...withoutWinner } = state;
			return withoutWinner;
		});
		const current = this.store.currentState();
		if (this.finalizingWinnerId === workerId && current.status !== "solved" && (released || current.winnerWorkerId === void 0)) {
			this.finalizingWinnerId = void 0;
			this.solutionFound = false;
			this.solutionDrainGate?.resolve();
			this.solutionDrainGate = void 0;
			this.notifier.notify();
		}
	}
	async finishSolvedDrain(workerId) {
		try {
			await this.onSolution();
		} catch (error) {
			this.onBackgroundError(error);
		} finally {
			if (this.finalizingWinnerId === workerId) this.finalizingWinnerId = void 0;
			this.solutionDrainGate?.resolve();
			this.solutionDrainGate = void 0;
			this.notifier.notify();
		}
	}
	/** Start a worker immediately or return a non-queuing admission failure. */
	async start(instruction) {
		const base = () => ({
			active: this.active.size,
			capacity: this.capacity(),
			overCapacity: this.active.size > this.capacity()
		});
		if (this.stopping || this.solutionFound) return {
			accepted: false,
			reason: "runtime_stopping",
			...base()
		};
		if (typeof instruction !== "string" || instruction.trim() === "" || instruction.length > 4e3) return {
			accepted: false,
			reason: "invalid_instruction",
			...base()
		};
		if (this.active.size + this.pendingAdmissions.size >= this.capacity()) return {
			accepted: false,
			reason: "capacity_full",
			...base()
		};
		const admission = Promise.withResolvers();
		this.pendingAdmissions.add(admission.promise);
		try {
			try {
				await this.assertInputsCurrent();
			} catch (error) {
				if (error instanceof ProblemChangedError) return {
					accepted: false,
					reason: "problem_changed",
					...base()
				};
				return {
					accepted: false,
					reason: "internal_error",
					...base()
				};
			}
			if (this.stopping || this.solutionFound) return {
				accepted: false,
				reason: "runtime_stopping",
				...base()
			};
			const otherAdmissions = Math.max(0, this.pendingAdmissions.size - 1);
			if (this.active.size + otherAdmissions >= this.capacity()) return {
				accepted: false,
				reason: "capacity_full",
				...base()
			};
			const id = randomUUID().slice(0, 8);
			const state = this.store.currentState();
			const now = (/* @__PURE__ */ new Date()).toISOString();
			const record = {
				version: 1,
				id,
				instruction: instruction.trim(),
				phase: "created",
				createdAt: now,
				updatedAt: now,
				problemDigest: state.problemDigest,
				...state.hintDigest === void 0 ? {} : { hintDigest: state.hintDigest },
				round: 0,
				theoremChecks: 0,
				artifactPaths: [`.alphasolve/workers/${id}.json`]
			};
			try {
				await this.store.writeWorker(record);
			} catch {
				return {
					accepted: false,
					reason: "internal_error",
					...base()
				};
			}
			if (this.stopping || this.solutionFound) return {
				accepted: false,
				reason: "runtime_stopping",
				...base()
			};
			const controller = new AbortController();
			this.activeRecords.set(id, record);
			const settled = this.driveWorker(record, controller).catch((error) => {
				try {
					this.onBackgroundError(error);
				} catch {}
			}).finally(() => {
				this.active.delete(id);
				this.activeRecords.delete(id);
				this.notifier.notify();
			});
			this.active.set(id, {
				id,
				controller,
				settled
			});
			return {
				accepted: true,
				workerId: id,
				active: this.active.size,
				capacity: this.capacity(),
				overCapacity: this.active.size > this.capacity()
			};
		} finally {
			this.pendingAdmissions.delete(admission.promise);
			admission.resolve();
		}
	}
	async driveWorker(initial, controller) {
		let record = initial;
		const progress = async (update) => {
			record = {
				...record,
				...update,
				id: record.id,
				version: 1,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			await this.store.writeWorker(record);
			this.activeRecords.set(record.id, record);
		};
		let result;
		let returnedResult;
		try {
			result = await this.executeWorkflow({
				id: record.id,
				instruction: record.instruction ?? "",
				signal: controller.signal,
				problemDigest: record.problemDigest,
				...record.hintDigest === void 0 ? {} : { hintDigest: record.hintDigest },
				progress,
				assertInputsCurrent: () => this.assertInputsCurrent(),
				claimSolvedWinner: () => this.claimSolvedWinner(record.id),
				releaseSolvedWinner: () => this.releaseSolvedWinner(record.id)
			});
			returnedResult = result;
			await this.assertInputsCurrent();
			if (result.status === "solved") {
				this.solutionFound = true;
				this.finalizingWinnerId ??= record.id;
				this.solutionDrainGate ??= Promise.withResolvers();
				const otherWorkers = [...this.active.values()].filter((worker) => worker.id !== record.id);
				for (const worker of otherWorkers) worker.controller.abort(/* @__PURE__ */ new Error("another worker solved the problem"));
				await Promise.allSettled(otherWorkers.map((worker) => worker.settled));
			}
		} catch (error) {
			try {
				await returnedResult?.rollbackPublishedSolution?.();
				await this.releaseSolvedWinner(record.id);
			} catch (releaseError) {
				this.onBackgroundError(releaseError);
			}
			if (error instanceof ProblemChangedError) result = {
				status: "stale_problem",
				producedVerifiedProposition: false,
				solved: false,
				failureStage: record.phase,
				reason: error.message,
				artifactPaths: record.artifactPaths
			};
			else if (controller.signal.aborted) result = {
				status: this.stopping ? this.stopStatus : "cancelled",
				producedVerifiedProposition: false,
				solved: false,
				failureStage: record.phase,
				reason: "worker was cancelled",
				artifactPaths: record.artifactPaths
			};
			else result = {
				status: "failed",
				producedVerifiedProposition: false,
				solved: false,
				failureStage: record.phase,
				reason: error instanceof Error ? error.message : String(error),
				artifactPaths: record.artifactPaths
			};
		}
		const completedAt = (/* @__PURE__ */ new Date()).toISOString();
		const summary = summarizeCompletion(result);
		const tracePaths = await this.store.listWorkerTracePaths(record.id);
		const completionArtifactPaths = [.../* @__PURE__ */ new Set([...result.artifactPaths, ...tracePaths])];
		let completionPublished = false;
		try {
			await progress({
				phase: "complete",
				terminalStatus: result.status,
				completedAt,
				summary,
				...result.statement === void 0 ? {} : { statement: result.statement },
				...result.propositionPath === void 0 ? {} : { verifiedPath: result.propositionPath },
				...result.failureStage === void 0 ? {} : { failureStage: result.failureStage },
				...result.reason === void 0 ? {} : { reason: result.reason },
				artifactPaths: completionArtifactPaths
			});
			await this.store.recordCompletion({
				workerId: record.id,
				status: result.status,
				startedAt: record.createdAt,
				completedAt,
				problemDigest: record.problemDigest,
				...record.hintDigest === void 0 ? {} : { hintDigest: record.hintDigest },
				producedVerifiedProposition: result.producedVerifiedProposition,
				solved: result.solved,
				summary,
				artifactPaths: completionArtifactPaths,
				...result.statement === void 0 ? {} : { statement: result.statement },
				...result.propositionPath === void 0 ? {} : { propositionPath: result.propositionPath },
				...result.failureStage === void 0 ? {} : { failureStage: result.failureStage },
				...result.reason === void 0 ? {} : { reason: result.reason }
			});
			completionPublished = true;
			if (result.status === "solved" && result.solved) {
				await this.store.updateState((state) => ({
					...state,
					status: "solved",
					winnerWorkerId: record.id
				}));
				await this.finishSolvedDrain(record.id);
			}
		} catch (error) {
			if (!completionPublished) try {
				completionPublished = (await this.store.listCompletions()).some((completion) => completion.workerId === record.id);
			} catch (inspectionError) {
				completionPublished = true;
				this.onBackgroundError(inspectionError);
			}
			if (!completionPublished) try {
				await result.rollbackPublishedSolution?.();
				await this.releaseSolvedWinner(record.id);
			} catch (releaseError) {
				this.onBackgroundError(releaseError);
			}
			else if (result.status === "solved" && result.solved) await this.finishSolvedDrain(record.id);
			throw error;
		}
	}
	/** Wait for and reserve all completions published since the last committed wait. */
	async wait(callId, signal) {
		if (signal.aborted) throw signal.reason ?? new DOMException("wait cancelled", "AbortError");
		for (;;) {
			const drainGate = this.solutionDrainGate;
			if (drainGate !== void 0) await waitWithAbort(drainGate.promise, signal);
			const generation = this.notifier.current();
			const completed = await this.store.reserveUndelivered(callId);
			if (completed.length > 0) {
				if (signal.aborted) {
					await this.store.releaseReservation(callId);
					throw signal.reason ?? new DOMException("wait cancelled", "AbortError");
				}
				return {
					status: "completed",
					completed,
					activeWorkerIds: this.activeIds(),
					active: this.active.size,
					capacity: this.capacity()
				};
			}
			if (this.active.size === 0) return {
				status: "no_active_workers",
				completed: [],
				activeWorkerIds: [],
				active: 0,
				capacity: this.capacity()
			};
			await this.notifier.waitAfter(generation, signal);
		}
	}
	/** Change the single hard capacity without cancelling over-capacity workers. */
	async configure(capacity) {
		if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive safe integer");
		const previousCapacity = this.capacity();
		await this.store.updateState((state) => ({
			...state,
			capacity
		}));
		return {
			previousCapacity,
			capacity,
			active: this.active.size,
			overCapacity: this.active.size > capacity
		};
	}
	/** Abort all workers and wait for every detached promise to settle. */
	async stop(status = "interrupted") {
		if (this.stopping) {
			await Promise.allSettled([...this.pendingAdmissions]);
			await Promise.allSettled([...this.active.values()].map((worker) => worker.settled));
			return;
		}
		this.stopping = true;
		this.stopStatus = status;
		this.notifier.notify();
		for (const worker of this.active.values()) worker.controller.abort(/* @__PURE__ */ new Error("AlphaSolve runtime is stopping"));
		await Promise.allSettled([...this.pendingAdmissions]);
		for (const worker of this.active.values()) worker.controller.abort(/* @__PURE__ */ new Error("AlphaSolve runtime is stopping"));
		await Promise.allSettled([...this.active.values()].map((worker) => worker.settled));
	}
};
//#endregion
//#region src/solution.ts
const VERIFIED_REFERENCE_PATTERN = /\\ref\{([^{}]+)\}/g;
var SolutionAssemblyError = class extends Error {
	code;
	details;
	constructor(code, message, details = {}) {
		super(message);
		this.code = code;
		this.details = details;
		this.name = "SolutionAssemblyError";
	}
};
function isInside(root, candidate) {
	const relative = path.relative(root, candidate);
	return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
/**
* Convert AlphaSolve's backslash citation syntax into a canonical POSIX label.
* No filesystem lookup happens here.
*/
function normalizeVerifiedReference(rawReference) {
	const raw = rawReference.trim();
	if (!raw || raw.includes("\0")) throw new SolutionAssemblyError("invalid-reference", "verified proposition reference is empty or invalid");
	if (/^[\\/]/.test(raw) || /^[A-Za-z]:[\\/]/.test(raw)) throw new SolutionAssemblyError("path-escape", `absolute verified proposition reference is forbidden: ${raw}`);
	const components = raw.replaceAll("\\", "/").split("/");
	if (components.some((component) => component === "" || component === "." || component === "..")) throw new SolutionAssemblyError("path-escape", `verified proposition reference escapes its root: ${raw}`);
	if (components.some((component) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(component))) throw new SolutionAssemblyError("invalid-reference", `invalid verified proposition reference: ${raw}`);
	if (components.at(-1)?.toLowerCase().endsWith(".md")) throw new SolutionAssemblyError("invalid-reference", `verified proposition references must omit .md: ${raw}`);
	return components.join("/");
}
/** Extract unique references in first-appearance order. */
function extractVerifiedReferences(text) {
	const references = [];
	const seen = /* @__PURE__ */ new Set();
	for (const match of text.matchAll(VERIFIED_REFERENCE_PATTERN)) {
		const label = normalizeVerifiedReference(match[1] ?? "");
		if (seen.has(label)) continue;
		seen.add(label);
		references.push(label);
	}
	return references;
}
async function canonicalVerifiedRoot(verifiedDir) {
	const lexicalRoot = path.resolve(verifiedDir);
	let rootInfo;
	try {
		rootInfo = await lstat(lexicalRoot);
	} catch (error) {
		throw new SolutionAssemblyError("unsafe-verified-root", `verified_propositions is unavailable: ${lexicalRoot}`, { cause: String(error) });
	}
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new SolutionAssemblyError("unsafe-verified-root", `verified_propositions must be a real directory, not a file or symlink: ${lexicalRoot}`);
	return realpath(lexicalRoot);
}
async function resolveRegularFileWithin(root, lexicalPath, display) {
	if (!isInside(root, lexicalPath)) throw new SolutionAssemblyError("path-escape", `proposition path escapes verified_propositions: ${display}`);
	let canonicalPath;
	try {
		canonicalPath = await realpath(lexicalPath);
	} catch (error) {
		throw new SolutionAssemblyError("missing-proposition", `missing verified proposition: ${display}`, { cause: String(error) });
	}
	if (!isInside(root, canonicalPath)) throw new SolutionAssemblyError("path-escape", `verified proposition symlink escapes verified_propositions: ${display}`, { resolvedPath: canonicalPath });
	if (!(await stat(canonicalPath)).isFile()) throw new SolutionAssemblyError("not-a-file", `verified proposition is not a regular file: ${display}`);
	return canonicalPath;
}
/**
* Assemble solution.md in memory. It performs a fail-closed DFS and returns
* dependencies before the propositions that cite them.
*/
async function assembleSolution(options) {
	const root = await canonicalVerifiedRoot(options.verifiedDir);
	const lexicalRoot = path.resolve(options.verifiedDir);
	const lexicalFinal = path.resolve(options.finalPropositionPath);
	if (!isInside(lexicalRoot, lexicalFinal)) throw new SolutionAssemblyError("path-escape", `final proposition must be inside verified_propositions: ${options.finalPropositionPath}`);
	const finalRelative = path.relative(lexicalRoot, lexicalFinal).split(path.sep).join("/");
	if (!finalRelative.toLowerCase().endsWith(".md")) throw new SolutionAssemblyError("invalid-reference", "final proposition must be a Markdown file");
	const finalLabel = normalizeVerifiedReference(finalRelative.slice(0, -3));
	const ordered = [];
	const visited = /* @__PURE__ */ new Set();
	const visiting = /* @__PURE__ */ new Set();
	const stack = [];
	const visit = async (label, lexicalPath) => {
		const canonicalPath = await resolveRegularFileWithin(root, lexicalPath, label);
		if (visited.has(canonicalPath)) return;
		if (visiting.has(canonicalPath)) throw new SolutionAssemblyError("cyclic-reference", `cyclic proposition reference detected: ${[...stack, label].join(" -> ")}`);
		visiting.add(canonicalPath);
		stack.push(label);
		const content = await readFile(canonicalPath, "utf8");
		for (const reference of extractVerifiedReferences(content)) {
			const dependencyPath = path.resolve(root, ...reference.split("/")) + ".md";
			await visit(reference, dependencyPath);
		}
		stack.pop();
		visiting.delete(canonicalPath);
		visited.add(canonicalPath);
		ordered.push({
			label,
			path: canonicalPath,
			content
		});
	};
	await visit(finalLabel, lexicalFinal);
	const output = [
		"# Solution",
		"",
		"## Problem",
		"",
		options.problemText.trim(),
		"",
		"## Verified Proposition Chain",
		""
	];
	ordered.forEach((proposition, index) => {
		output.push(`### ${index + 1}. ${path.posix.basename(proposition.label)}`, "", proposition.content.trim(), "");
	});
	return {
		text: `${output.join("\n").trimEnd()}\n`,
		propositions: ordered
	};
}
/**
* Write a complete text file atomically using a same-filesystem temporary.
* With replaceExisting=false, hard-link publication makes EEXIST fail closed.
*/
async function writeTextAtomically(targetPath, text, options = {}) {
	const target = path.resolve(targetPath);
	const targetDirectory = path.dirname(target);
	const tempDirectory = path.resolve(options.tempDir ?? path.join(targetDirectory, ".alphasolve", "tmp"));
	await mkdir(targetDirectory, { recursive: true });
	await mkdir(tempDirectory, { recursive: true });
	const [targetDirectoryInfo, tempDirectoryInfo] = await Promise.all([stat(targetDirectory), stat(tempDirectory)]);
	if (targetDirectoryInfo.dev !== tempDirectoryInfo.dev) throw new SolutionAssemblyError("cross-device-temp", `atomic write temp directory is on another filesystem: ${tempDirectory}`);
	const temporary = path.join(tempDirectory, `solution-${process.pid}-${randomUUID()}.tmp`);
	let temporaryExists = false;
	try {
		const handle = await open(temporary, "wx", 384);
		temporaryExists = true;
		try {
			await handle.writeFile(text, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (options.replaceExisting) {
			await rename(temporary, target);
			temporaryExists = false;
		} else {
			await link(temporary, target);
			await unlink(temporary);
			temporaryExists = false;
		}
		return target;
	} finally {
		if (temporaryExists) await unlink(temporary).catch(() => void 0);
	}
}
/** Assemble, validate, and atomically publish solution.md. */
async function writeSolutionAtomically(options) {
	const assembled = await assembleSolution(options);
	const solutionPath = await writeTextAtomically(options.solutionPath, assembled.text, options);
	return {
		...assembled,
		solutionPath
	};
}
var PropositionWriteConflictError = class extends Error {
	constructor(message = "active proposition changed outside its owning role", options) {
		super(message, options);
		this.name = "PropositionWriteConflictError";
	}
};
/**
* A role or its result-processing infrastructure failed before it produced a
* completed mathematical verdict.  This is deliberately distinct from a
* verifier's explicit (or completed-but-ambiguous) fail verdict: only the
* latter is useful input to the reviser.
*/
var WorkflowInfrastructureError = class extends Error {
	stage;
	constructor(stage, error) {
		const detail = error instanceof Error ? error.message : String(error);
		super(`${stage} infrastructure failure: ${detail}`, { cause: error });
		this.stage = stage;
		this.name = "WorkflowInfrastructureError";
	}
};
const PROFILE_TO_SHORT = {
	verifier_format_references: "format_references",
	verifier_citation: "citation",
	verifier_failure_modes: "failure_modes",
	verifier_stepwise: "stepwise",
	verifier_premise_chain: "premise_chain"
};
function throwIfAborted(signal) {
	if (signal.aborted) throw signal.reason ?? new DOMException("worker cancelled", "AbortError");
}
function errnoCode(error) {
	return error !== null && typeof error === "object" && "code" in error ? String(error.code) : void 0;
}
function safeWorkerId(id) {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new TypeError(`unsafe worker id: ${id}`);
	return id;
}
async function makeWorkerPaths(workspace, workerId) {
	const workerRelative = `unverified_propositions/prop-${safeWorkerId(workerId)}`;
	const propositionRelative = `${workerRelative}/proposition.md`;
	const reviewRelative = `${workerRelative}/review.md`;
	const theoremCheckRelative = `${workerRelative}/theorem_check.md`;
	const [workerDirectory, propositionPath, reviewPath, theoremCheckPath, verifiedDir, solutionPath] = await Promise.all([
		resolveWorkspacePath(workspace, workerRelative, { mustExist: false }),
		resolveWorkspacePath(workspace, propositionRelative, { mustExist: false }),
		resolveWorkspacePath(workspace, reviewRelative, { mustExist: false }),
		resolveWorkspacePath(workspace, theoremCheckRelative, { mustExist: false }),
		resolveWorkspacePath(workspace, "verified_propositions", { mustExist: true }),
		resolveWorkspacePath(workspace, "solution.md", { mustExist: false })
	]);
	return {
		workerRelative,
		workerDirectory,
		propositionRelative,
		propositionPath,
		reviewRelative,
		reviewPath,
		theoremCheckRelative,
		theoremCheckPath,
		verifiedDir,
		solutionPath
	};
}
function rolePromptName(role) {
	return role;
}
function roleMaxTurns(role) {
	return ROLE_MAX_TURNS[rolePromptName(role)];
}
async function invoke(options, context, paths, request) {
	throwIfAborted(context.signal);
	return options.invoker.invoke({
		...request,
		workerId: context.id,
		workspace: options.workspace,
		workerDirectory: paths.workerDirectory,
		propositionPath: paths.propositionPath,
		signal: context.signal,
		maxTurns: roleMaxTurns(request.role)
	});
}
async function assertPropositionUnchanged(workspace, relativePath, stamp) {
	try {
		await assertFileStamp(workspace, relativePath, stamp);
	} catch (error) {
		throw new PropositionWriteConflictError(void 0, { cause: error });
	}
}
async function readCurrentInputs(context, workspace) {
	await context.assertInputsCurrent();
	const problem = await readWorkspaceInput(workspace, "problem.md", { nonEmpty: true });
	if (!await workspaceFileExists(workspace, "hint.md")) return { problem: problem.content };
	const hint = await readWorkspaceInput(workspace, "hint.md", { nonEmpty: false });
	return {
		problem: problem.content,
		hint: hint.content
	};
}
async function chooseCandidateFilename(options, context, paths, propositionText) {
	let raw = "";
	if (options.filenameBuilder !== void 0) try {
		raw = await options.filenameBuilder({
			workerId: context.id,
			propositionText,
			prompt: buildPropositionFilenameTask(propositionText),
			signal: context.signal
		});
	} catch (error) {
		if (context.signal.aborted) throw error;
		raw = "";
	}
	const parsed = parsePropositionFilename(raw, context.id);
	const extension = path.extname(parsed);
	const stem = path.basename(parsed, extension);
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const filename = attempt === 0 ? parsed : `${stem}-${randomUUID().slice(0, 6)}${extension}`;
		try {
			await lstat(path.join(paths.verifiedDir, filename));
		} catch (error) {
			if (errnoCode(error) === "ENOENT") return filename;
			throw error;
		}
	}
	throw new Error("unable to allocate a unique verified proposition filename");
}
async function buildCandidateView(workspace, workerId, paths, filename) {
	const root = await resolveWorkspacePath(workspace, `.alphasolve/tmp/theorem-${safeWorkerId(workerId)}-${randomUUID().slice(0, 8)}`, { mustExist: false });
	const verifiedDir = path.join(root, "verified_propositions");
	await mkdir(root, {
		recursive: false,
		mode: 448
	});
	try {
		await cp(paths.verifiedDir, verifiedDir, {
			recursive: true,
			force: false,
			errorOnExist: true,
			dereference: false,
			verbatimSymlinks: true
		});
		const candidatePath = path.join(verifiedDir, filename);
		await copyFile(paths.propositionPath, candidatePath);
		return {
			root,
			verifiedDir,
			candidatePath,
			candidateRelativeForAgent: `verified_propositions/${filename}`
		};
	} catch (error) {
		await rm(root, {
			recursive: true,
			force: true
		});
		throw error;
	}
}
async function promoteCandidate(paths, preferredFilename, content, tempDir) {
	const extension = path.extname(preferredFilename);
	const stem = path.basename(preferredFilename, extension);
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const filename = attempt === 0 ? preferredFilename : `${stem}-${randomUUID().slice(0, 6)}${extension}`;
		const target = path.join(paths.verifiedDir, filename);
		try {
			await writeTextAtomically(target, content, { tempDir });
			return {
				path: target,
				relativePath: `verified_propositions/${filename}`
			};
		} catch (error) {
			if (errnoCode(error) !== "EEXIST") throw error;
		}
	}
	throw new Error("unable to atomically promote a verified proposition after filename conflicts");
}
function artifactPaths(paths, extras = []) {
	return [
		paths.workerRelative,
		paths.propositionRelative,
		paths.reviewRelative,
		...extras
	];
}
function workflowArtifactPaths(options, context, paths, extras = []) {
	return [.../* @__PURE__ */ new Set([
		...artifactPaths(paths),
		...options.invoker.artifactPaths?.(context.id) ?? [],
		...extras
	])];
}
async function runVerificationRound(options, context, paths, propositionText, propositionStamp, round) {
	for (const [index, role] of VERIFIER_PROFILE_ORDER.entries()) {
		const profile = PROFILE_TO_SHORT[role];
		await context.assertInputsCurrent();
		await assertPropositionUnchanged(options.workspace, paths.propositionRelative, propositionStamp);
		await context.progress({
			phase: "verifier",
			round,
			verifierProfile: profile
		});
		let review;
		try {
			review = (await invoke(options, context, paths, {
				role,
				cwd: options.workspace,
				persona: loadRolePrompt(role),
				task: buildVerifierTask({
					propositionPath: paths.propositionRelative,
					propositionText,
					workflowIndex: round,
					attemptIndex: index + 1,
					attemptTotal: VERIFIER_PROFILE_ORDER.length,
					profile
				}),
				verifierProfile: profile,
				workflowRound: round,
				verifierAttempt: index + 1,
				expectedPropositionStamp: propositionStamp
			})).text;
			await assertPropositionUnchanged(options.workspace, paths.propositionRelative, propositionStamp);
		} catch (error) {
			if (context.signal.aborted) throw error;
			if (error instanceof PropositionWriteConflictError) throw error;
			throw new WorkflowInfrastructureError(`verifier:${profile}`, error);
		}
		try {
			await writeTextAtomically(paths.reviewPath, review, { replaceExisting: true });
		} catch (error) {
			throw new WorkflowInfrastructureError(`verifier:${profile}:review_artifact`, error);
		}
		let verdict = "fail";
		try {
			verdict = parseVerifierVerdict((await invoke(options, context, paths, {
				role: "review_verdict_judge",
				cwd: options.workspace,
				persona: loadRolePrompt("review_verdict_judge"),
				task: buildReviewVerdictTask(review, round, index + 1),
				verifierProfile: profile,
				workflowRound: round,
				verifierAttempt: index + 1,
				expectedPropositionStamp: propositionStamp
			})).text);
			await assertPropositionUnchanged(options.workspace, paths.propositionRelative, propositionStamp);
		} catch (error) {
			if (context.signal.aborted) throw error;
			if (error instanceof PropositionWriteConflictError) throw error;
			throw new WorkflowInfrastructureError(`review_verdict_judge:${profile}`, error);
		}
		if (verdict !== "pass") return {
			profile,
			review
		};
	}
}
async function defaultSolutionPublisher(request, replaceExisting) {
	throwIfAborted(request.signal);
	return (await writeSolutionAtomically({
		problemText: request.problemText,
		verifiedDir: request.verifiedDir,
		finalPropositionPath: request.finalPropositionPath,
		solutionPath: request.solutionPath,
		replaceExisting
	})).solutionPath;
}
async function executeFixedWorkflow(options, context) {
	const paths = await makeWorkerPaths(options.workspace, context.id);
	const artifacts = () => workflowArtifactPaths(options, context, paths);
	let ownsWinnerClaim = false;
	let winnerPromotedPath;
	let publishedSolutionPath;
	let currentStatement;
	const rollbackPublishedSolution = async () => {
		const cleanupErrors = [];
		for (const target of [publishedSolutionPath, winnerPromotedPath]) {
			if (target === void 0) continue;
			try {
				await unlink(target);
			} catch (cleanupError) {
				if (cleanupError.code !== "ENOENT") cleanupErrors.push(cleanupError);
			}
		}
		if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "failed to roll back solution publication files");
	};
	try {
		throwIfAborted(context.signal);
		const inputs = await readCurrentInputs(context, options.workspace);
		await mkdir(paths.workerDirectory, {
			recursive: false,
			mode: 448
		});
		if (context.instruction.trim()) await writeTextAtomically(path.join(paths.workerDirectory, "worker_hint.md"), context.instruction);
		await context.progress({
			phase: "generator",
			round: 0,
			artifactPaths: artifacts()
		});
		await invoke(options, context, paths, {
			role: "generator",
			cwd: options.workspace,
			persona: loadRolePrompt("generator"),
			task: buildGeneratorTask({
				problem: inputs.problem,
				workerRelativePath: paths.workerRelative,
				instruction: context.instruction,
				...inputs.hint === void 0 ? {} : { hint: inputs.hint }
			})
		});
		throwIfAborted(context.signal);
		let proposition;
		try {
			proposition = await readWorkspaceInput(options.workspace, paths.propositionRelative, { nonEmpty: true });
		} catch (error) {
			return {
				status: "rejected",
				producedVerifiedProposition: false,
				solved: false,
				failureStage: "generator",
				reason: `generator did not produce a readable, non-empty proposition.md: ${error instanceof Error ? error.message : String(error)}`,
				artifactPaths: [paths.workerRelative]
			};
		}
		let propositionText = proposition.content;
		currentStatement = extractStatement(propositionText).trim();
		let propositionStamp = await captureFileStamp(options.workspace, paths.propositionRelative);
		await context.progress({ propositionPath: paths.propositionRelative });
		let finalFailure;
		for (let round = 1; round <= 6; round += 1) {
			finalFailure = await runVerificationRound(options, context, paths, propositionText, propositionStamp, round);
			if (finalFailure === void 0) break;
			if (round === 6) return {
				status: "rejected",
				producedVerifiedProposition: false,
				solved: false,
				statement: extractStatement(propositionText).trim(),
				failureStage: `verifier:${finalFailure.profile}`,
				reason: finalFailure.review.slice(0, 4e3),
				artifactPaths: artifacts()
			};
			await context.assertInputsCurrent();
			await assertPropositionUnchanged(options.workspace, paths.propositionRelative, propositionStamp);
			await context.progress({
				phase: "reviser",
				round
			});
			await invoke(options, context, paths, {
				role: "reviser",
				cwd: options.workspace,
				persona: loadRolePrompt("reviser"),
				task: buildReviserTask(paths.propositionRelative, finalFailure.review, round),
				workflowRound: round,
				expectedPropositionStamp: propositionStamp
			});
			throwIfAborted(context.signal);
			proposition = await readWorkspaceInput(options.workspace, paths.propositionRelative, { nonEmpty: true });
			propositionText = proposition.content;
			currentStatement = extractStatement(propositionText).trim();
			propositionStamp = await captureFileStamp(options.workspace, paths.propositionRelative);
		}
		await context.assertInputsCurrent();
		await assertPropositionUnchanged(options.workspace, paths.propositionRelative, propositionStamp);
		const candidateFilename = await chooseCandidateFilename(options, context, paths, propositionText);
		const candidateView = await buildCandidateView(options.workspace, context.id, paths, candidateFilename);
		let solved = true;
		let theoremInfrastructureFailure;
		const theoremAnswers = [];
		try {
			for (let attempt = 1; attempt <= 5; attempt += 1) {
				await context.assertInputsCurrent();
				await assertPropositionUnchanged(options.workspace, paths.propositionRelative, propositionStamp);
				await context.progress({
					phase: "theorem_checker",
					theoremChecks: attempt
				});
				try {
					const check = await invoke(options, context, paths, {
						role: "theorem_checker",
						cwd: candidateView.root,
						theoremViewDirectory: candidateView.root,
						persona: loadRolePrompt("theorem_checker"),
						task: buildTheoremCheckerTask(inputs.problem, candidateView.candidateRelativeForAgent),
						theoremAttempt: attempt,
						expectedPropositionStamp: propositionStamp
					});
					theoremAnswers.push(check.text);
					if (!solvesOriginalProblem(check.text)) {
						solved = false;
						break;
					}
				} catch (error) {
					if (context.signal.aborted) throw error;
					if (error instanceof PropositionWriteConflictError) throw error;
					theoremInfrastructureFailure = new WorkflowInfrastructureError(`theorem_checker:${attempt}`, error);
					theoremAnswers.push(theoremInfrastructureFailure.message);
					solved = false;
					break;
				}
			}
		} finally {
			await rm(candidateView.root, {
				recursive: true,
				force: true
			});
		}
		const theoremCheckText = [
			"# Theorem Check",
			"",
			...theoremAnswers.flatMap((answer, index) => [
				`## Attempt ${index + 1}`,
				"",
				answer.trim(),
				""
			])
		].join("\n").trimEnd() + "\n";
		await writeTextAtomically(paths.theoremCheckPath, theoremCheckText);
		await context.assertInputsCurrent();
		await assertPropositionUnchanged(options.workspace, paths.propositionRelative, propositionStamp);
		await context.progress({ phase: "arbitrating" });
		if (solved) {
			if (!await context.claimSolvedWinner()) return {
				status: "discarded_after_solution",
				producedVerifiedProposition: false,
				solved: true,
				statement: extractStatement(propositionText).trim(),
				reason: "another worker committed the solved winner first",
				artifactPaths: workflowArtifactPaths(options, context, paths, [paths.theoremCheckRelative])
			};
			ownsWinnerClaim = true;
			await context.assertInputsCurrent();
			await assertPropositionUnchanged(options.workspace, paths.propositionRelative, propositionStamp);
		}
		await context.progress({ phase: "promoting" });
		const promoted = await promoteCandidate(paths, candidateFilename, propositionText, path.join(options.workspace, ".alphasolve", "tmp"));
		if (solved) winnerPromotedPath = promoted.path;
		await context.progress({ verifiedPath: promoted.relativePath });
		const statement = extractStatement(propositionText).trim();
		if (!solved) {
			if (theoremInfrastructureFailure !== void 0) return {
				status: "failed",
				producedVerifiedProposition: true,
				solved: false,
				statement,
				propositionPath: promoted.relativePath,
				failureStage: theoremInfrastructureFailure.stage,
				reason: theoremInfrastructureFailure.message,
				artifactPaths: workflowArtifactPaths(options, context, paths, [paths.theoremCheckRelative])
			};
			return {
				status: "verified",
				producedVerifiedProposition: true,
				solved: false,
				statement,
				propositionPath: promoted.relativePath,
				artifactPaths: workflowArtifactPaths(options, context, paths, [paths.theoremCheckRelative])
			};
		}
		await context.assertInputsCurrent();
		throwIfAborted(context.signal);
		const publishedSolution = await (options.solutionPublisher ?? ((request) => defaultSolutionPublisher(request, options.replaceExistingSolution ?? false)))({
			workerId: context.id,
			workspace: options.workspace,
			problemText: inputs.problem,
			verifiedDir: paths.verifiedDir,
			finalPropositionPath: promoted.path,
			solutionPath: paths.solutionPath,
			signal: context.signal
		});
		publishedSolutionPath = paths.solutionPath;
		if (path.resolve(publishedSolution) !== path.resolve(paths.solutionPath)) throw new Error("solution publisher returned an unexpected path");
		await context.assertInputsCurrent();
		throwIfAborted(context.signal);
		return {
			status: "solved",
			producedVerifiedProposition: true,
			solved: true,
			statement,
			propositionPath: promoted.relativePath,
			artifactPaths: workflowArtifactPaths(options, context, paths, [paths.theoremCheckRelative, path.relative(options.workspace, path.resolve(publishedSolution))]),
			rollbackPublishedSolution
		};
	} catch (error) {
		if (ownsWinnerClaim) {
			let cleanupFailure;
			try {
				await rollbackPublishedSolution();
			} catch (cleanupError) {
				cleanupFailure = cleanupError;
			}
			await context.releaseSolvedWinner?.();
			if (cleanupFailure !== void 0) throw new AggregateError([error, cleanupFailure], "failed to roll back an invalidated solution publication");
		}
		if (error instanceof PropositionWriteConflictError) return {
			status: "write_conflict",
			producedVerifiedProposition: false,
			solved: false,
			failureStage: "proposition_stamp",
			reason: error.message,
			artifactPaths: artifacts()
		};
		if (error instanceof WorkflowInfrastructureError) return {
			status: "failed",
			producedVerifiedProposition: false,
			solved: false,
			...currentStatement === void 0 || currentStatement === "" ? {} : { statement: currentStatement },
			failureStage: error.stage,
			reason: error.message,
			artifactPaths: artifacts()
		};
		throw error;
	}
}
/** Create the WorkerManager-compatible executor for one locked session. */
function createFixedWorkerExecutor(options) {
	const workspace = path.resolve(options.workspace);
	return (context) => executeFixedWorkflow({
		...options,
		workspace
	}, context);
}
//#endregion
//#region src/runtime.ts
/** Session-owned AlphaSolve runtime: durable state, workers, tools, and teardown. */
const RUNTIME_TOOL_NAMES = Object.freeze({
	worker: "alphasolve_worker",
	wait: "alphasolve_wait",
	configure: "alphasolve_configure",
	researchReview: "alphasolve_research_review",
	stop: "alphasolve_stop"
});
const ALPHASOLVE_REQUIRED_FILE_TOOLS = [
	"read",
	"write",
	"edit",
	"glob",
	"grep"
];
const WEB_TOOLS = [
	"web",
	"web_search",
	"web_fetch"
];
const AGENT_PRESET_MISSING_TOOLS_REASON = "agent_preset_missing_required_tools";
const AGENT_PRESET_BLOCKS_PROMPT_REASON = "agent_preset_blocks_alphasolve_prompt";
/** Inspect the complete inherited catalog for this exact live Agent scope. */
function inspectAlphaSolveAgentCapabilities(agent) {
	const agentPreset = agent.ctx.get("agentPresets")?.composedPreset(agent.ctx);
	const missingTools = ALPHASOLVE_REQUIRED_FILE_TOOLS.filter((name) => agent.ctx.tools.get(name, agent) === void 0);
	return Object.freeze({
		...agentPreset === void 0 ? {} : { agentPreset },
		missingTools: Object.freeze(missingTools)
	});
}
/** Curator-helper output is already part of its parent task and must not self-enqueue. */
function shouldEnqueueCuratorTrace(event) {
	return event.parentRole !== "curator";
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function isMissing(error) {
	return error?.code === "ENOENT" || (error?.cause)?.code === "ENOENT";
}
function argumentRecord$1(args, tool) {
	if (args === null || typeof args !== "object" || Array.isArray(args)) throw new TypeError(`${tool} arguments must be an object`);
	return args;
}
function exactKeys(record, allowed, tool) {
	const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
	if (unexpected.length > 0) throw new TypeError(`${tool} received unexpected argument ${unexpected[0]}`);
}
function requiredString(record, field, tool) {
	const value = record[field];
	if (typeof value !== "string") throw new TypeError(`${tool}.${field} must be a string`);
	return value;
}
function optionalString(record, field, tool) {
	const value = record[field];
	if (value === void 0) return void 0;
	if (typeof value !== "string") throw new TypeError(`${tool}.${field} must be a string`);
	return value;
}
function positiveInteger(value, label) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`);
	return value;
}
function throwIfActivationCancelled(signal) {
	if (!signal?.aborted) return;
	throw signal.reason ?? new DOMException("AlphaSolve activation cancelled", "AbortError");
}
function jsonTool(options) {
	return {
		name: options.name,
		description: options.description,
		parameters: options.parameters,
		output: {
			schema: options.outputSchema ?? { type: "object" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		...options.concurrencySafe === true ? { isConcurrencySafe: () => true } : {},
		execute: options.execute
	};
}
/** Shadow a standard DSH write/edit tool with AlphaSolve main's index-only schema. */
function narrowedIndexTool(definition) {
	const parameters = structuredClone(definition.parameters);
	const filePath = argumentRecord$1(argumentRecord$1(argumentRecord$1(parameters, `${definition.name} schema`).properties, `${definition.name} schema.properties`).file_path, `${definition.name} schema.properties.file_path`);
	filePath.pattern = ORCHESTRATOR_INDEX_PATH_PATTERN;
	return {
		...definition,
		description: `${definition.description}\n\nDuring AlphaSolve this tool is restricted to verified_propositions/**/index.md; it cannot create or edit a proposition proof.`,
		parameters
	};
}
function successfulToolResult(event) {
	return event.data.message.content[0].isError === false;
}
function toolResultJson(event) {
	if (!successfulToolResult(event)) return void 0;
	const text = event.data.message.content[0].content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	if (text === "") return void 0;
	try {
		const value = JSON.parse(text);
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
	} catch {
		return;
	}
}
/**
* A successful activation is durable user authorization for this session.
* Any later stop call wins even if the process died before its result was
* appended: fail closed rather than resurrecting an intentionally stopped run.
*/
function hasDurableAlphaSolveResumeIntent(events) {
	const calls = /* @__PURE__ */ new Map();
	let latestActivation = -1;
	let latestStop = -1;
	for (const event of events) {
		if (event.type === "tool/call") {
			const callId = String(event.data.callId);
			calls.set(callId, {
				name: event.data.name,
				sequence: event.seq
			});
			if (event.data.name === RUNTIME_TOOL_NAMES.stop) latestStop = Math.max(latestStop, event.seq);
			continue;
		}
		if (event.type !== "tool/result") continue;
		const call = calls.get(String(event.data.message.source.callId));
		if (call?.name !== ACTIVATE_TOOL_NAME_FOR_RECOVERY) continue;
		if (toolResultJson(event)?.activated === true) latestActivation = Math.max(latestActivation, call.sequence);
	}
	return latestActivation >= 0 && latestActivation > latestStop;
}
const ACTIVATE_TOOL_NAME_FOR_RECOVERY = "alphasolve_activate";
/** Read-only, fail-closed eligibility check before taking a workspace lock. */
async function probeRuntimeRestore(agent) {
	const workspace = agent.session.header.cwd ?? "";
	if (!hasDurableAlphaSolveResumeIntent(agent.session.events)) return {
		candidate: false,
		workspace
	};
	let canonical;
	try {
		canonical = await canonicalWorkspace(agent.session.header.cwd);
	} catch (error) {
		return {
			candidate: false,
			workspace,
			reason: errorMessage(error)
		};
	}
	const statePath = await resolveWorkspacePath(canonical, ".alphasolve/state.json", { mustExist: false });
	let state;
	try {
		state = parseSessionState(await readJsonObject(statePath), statePath);
	} catch (error) {
		if (isMissing(error)) return {
			candidate: false,
			workspace: canonical,
			reason: "persisted AlphaSolve activation exists but .alphasolve/state.json is missing"
		};
		return {
			candidate: false,
			workspace: canonical,
			reason: errorMessage(error)
		};
	}
	if (state.sessionId !== String(agent.id)) return {
		candidate: false,
		workspace: canonical
	};
	if (state.workspace !== canonical) return {
		candidate: false,
		workspace: canonical,
		reason: "persisted AlphaSolve workspace does not match this session workspace"
	};
	let snapshot;
	try {
		snapshot = await snapshotWorkspace(canonical);
	} catch (error) {
		return {
			candidate: false,
			workspace: canonical,
			reason: errorMessage(error)
		};
	}
	if (snapshot.problem.digest !== state.problemDigest) return {
		candidate: false,
		workspace: canonical,
		reason: "problem.md changed since AlphaSolve was active; request AlphaSolve explicitly to begin a new generation"
	};
	if (state.status === "solved") try {
		const undeliveredSolved = (await new RuntimeStore(canonical).listCompletions()).some((completion) => completion.solved && completion.problemDigest === state.problemDigest && completion.deliveredByCallId === void 0);
		const curatorNeedsRecovery = await hasRecoverableCuratorTasks(canonical);
		if (!undeliveredSolved && !curatorNeedsRecovery) return {
			candidate: false,
			workspace: canonical
		};
	} catch (error) {
		return {
			candidate: false,
			workspace: canonical,
			reason: errorMessage(error)
		};
	}
	return {
		candidate: true,
		workspace: canonical
	};
}
function committedToolCallIds(agent) {
	const result = /* @__PURE__ */ new Set();
	for (const event of agent.session.events) if (event.type === "tool/result" && successfulToolResult(event)) result.add(String(event.data.message.source.callId));
	return result;
}
async function optionalLstat(file) {
	try {
		return await lstat(file);
	} catch (error) {
		if (isMissing(error)) return void 0;
		throw error;
	}
}
/** Atomic publication means a present, ordinary non-empty AlphaSolve header is complete. */
async function hasCompleteSolution(snapshot) {
	if (!snapshot.solutionExists) return false;
	const solution = await readWorkspaceInput(snapshot.root, "solution.md", { nonEmpty: true });
	return /^# Solution(?:\r?\n|$)/.test(solution.content);
}
async function archivePreviousGeneration(workspace, problemDigest, options = {}) {
	const statePath = await resolveWorkspacePath(workspace, ".alphasolve/state.json", { mustExist: false });
	const stateInfo = await optionalLstat(statePath);
	if (stateInfo === void 0) return false;
	if (!stateInfo.isFile() || stateInfo.isSymbolicLink()) throw new Error(`AlphaSolve state is not an ordinary file: ${statePath}`);
	const prior = parseSessionState(await readJsonObject(statePath), statePath);
	if (prior.problemDigest === problemDigest && prior.status !== "solved") return false;
	const validationStore = new RuntimeStore(workspace);
	await validationStore.listCompletions();
	await validationStore.validateWorkers();
	await hasRecoverableCuratorTasks(workspace);
	const backup = await resolveWorkspacePath(workspace, `.alphasolve/backups/generation-${`${(/* @__PURE__ */ new Date()).toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID().slice(0, 8)}`}`, { mustExist: false });
	await mkdir(backup, { mode: 448 });
	const completions = await resolveWorkspacePath(workspace, ".alphasolve/completions", { mustExist: true });
	await rename(completions, path.join(backup, "completions"));
	await mkdir(completions, { mode: 448 });
	await options.afterPhase?.("completions", backup);
	const workers = await resolveWorkspacePath(workspace, ".alphasolve/workers", { mustExist: true });
	await rename(workers, path.join(backup, "workers"));
	await mkdir(workers, { mode: 448 });
	await options.afterPhase?.("workers", backup);
	const queue = await resolveWorkspacePath(workspace, ".alphasolve/curator/queue.json", { mustExist: false });
	if (await optionalLstat(queue) !== void 0) await rename(queue, path.join(backup, "curator-queue.json"));
	await options.afterPhase?.("curator", backup);
	await atomicWriteJson(path.join(backup, "generation.json"), {
		archivedAt: (/* @__PURE__ */ new Date()).toISOString(),
		previousProblemDigest: prior.problemDigest,
		nextProblemDigest: problemDigest,
		previousStatus: prior.status
	});
	await options.afterPhase?.("metadata", backup);
	await rename(statePath, path.join(backup, "state.json"));
	await options.afterPhase?.("committed", backup);
	return true;
}
function initialState(agent, snapshot, config) {
	const now = (/* @__PURE__ */ new Date()).toISOString();
	return {
		version: 1,
		sessionId: String(agent.id),
		workspace: snapshot.root,
		activatedAt: now,
		updatedAt: now,
		status: "active",
		problemDigest: snapshot.problem.digest,
		...snapshot.hint === void 0 ? {} : { hintDigest: snapshot.hint.digest },
		capacity: config.capacity,
		detailedTrace: config.detailedTrace,
		modelOverrides: config.models,
		nextCompletionSequence: 1
	};
}
/** One locked, session-isolated AlphaSolve runtime. */
var AlphaSolveRuntime = class AlphaSolveRuntime {
	agent;
	lock;
	config;
	curator;
	roleService;
	projectTools;
	replaceExistingSolution;
	terminalRecovery;
	onDisposed;
	workspace;
	store;
	manager;
	fiber;
	waitCalls = /* @__PURE__ */ new Set();
	solvedWaitCalls = /* @__PURE__ */ new Set();
	solvedResultCommitted = false;
	stopCallId;
	stopResultCommitted = false;
	turnSettled = false;
	pendingSessionCommits = /* @__PURE__ */ new Set();
	pendingSessionCommitErrors = [];
	completionsSinceResearchReview = /* @__PURE__ */ new Set();
	shutdownPromise;
	disposed = false;
	constructor(agent, lock, store, config, curator, roleService, manager, projectTools, replaceExistingSolution, terminalRecovery, onDisposed) {
		this.agent = agent;
		this.lock = lock;
		this.config = config;
		this.curator = curator;
		this.roleService = roleService;
		this.projectTools = projectTools;
		this.replaceExistingSolution = replaceExistingSolution;
		this.terminalRecovery = terminalRecovery;
		this.onDisposed = onDisposed;
		this.workspace = store.workspace;
		this.store = store;
		this.manager = manager;
	}
	static async prepare(agent, request, defaults, onDisposed, signal, mode = "explicit") {
		throwIfActivationCancelled(signal);
		if (request.capacity !== void 0) positiveInteger(request.capacity, "capacity");
		const snapshot = await snapshotWorkspace(agent.session.header.cwd);
		throwIfActivationCancelled(signal);
		const loaded = mode === "explicit" ? await loadAlphaSolveConfig(snapshot.root, {
			...request.capacity === void 0 ? {} : { promptCapacity: request.capacity },
			...defaults.defaultCapacity === void 0 ? {} : { defaultCapacity: defaults.defaultCapacity },
			...defaults.defaultDetailedTrace === void 0 ? {} : { defaultDetailedTrace: defaults.defaultDetailedTrace }
		}) : void 0;
		throwIfActivationCancelled(signal);
		await initializeWorkspace(snapshot.root);
		throwIfActivationCancelled(signal);
		const lock = await acquireWorkspaceLock(snapshot.root, String(agent.id));
		let curator;
		try {
			throwIfActivationCancelled(signal);
			const latest = await snapshotWorkspace(snapshot.root);
			throwIfActivationCancelled(signal);
			if (latest.problem.digest !== snapshot.problem.digest) throw new Error("problem.md changed while AlphaSolve activation was being prepared; retry explicitly");
			let recoveredConfig;
			if (mode === "session-resume") {
				const statePath = await resolveWorkspacePath(snapshot.root, ".alphasolve/state.json", { mustExist: true });
				const persisted = parseSessionState(await readJsonObject(statePath), statePath);
				if (persisted.sessionId !== String(agent.id)) throw new Error("persisted AlphaSolve state belongs to a different session");
				if (persisted.workspace !== latest.root) throw new Error("persisted AlphaSolve workspace changed during session recovery");
				if (persisted.problemDigest !== latest.problem.digest) throw new Error("problem.md changed during AlphaSolve session recovery");
				recoveredConfig = {
					capacity: persisted.capacity,
					detailedTrace: persisted.detailedTrace,
					models: persisted.modelOverrides
				};
			}
			const activationConfig = recoveredConfig ?? loaded?.resolved;
			if (activationConfig === void 0) throw new Error("AlphaSolve activation configuration is unavailable");
			let store = new RuntimeStore(snapshot.root);
			let opened = await store.open(initialState(agent, latest, activationConfig));
			if (mode === "session-resume") {
				if (!opened.resumed) throw new Error("persisted AlphaSolve state disappeared during session recovery");
			}
			await store.validateWorkers();
			await store.recoverInterruptedWorkers();
			await store.recoverReservations(committedToolCallIds(agent));
			const completeSolution = await hasCompleteSolution(latest);
			const terminalCompletion = await store.reconcileSolvedTerminal(completeSolution);
			const curatorNeedsRecovery = await hasRecoverableCuratorTasks(snapshot.root);
			const sameProblem = store.currentState().problemDigest === latest.problem.digest;
			const terminalRecovery = sameProblem && terminalCompletion !== void 0 && (terminalCompletion.deliveredByCallId === void 0 || curatorNeedsRecovery);
			let preservePersistedConfig = opened.resumed && store.currentState().sessionId === String(agent.id) && store.currentState().workspace === latest.root && sameProblem;
			let resumed = opened.resumed;
			if (mode === "session-resume") {
				if (store.currentState().status === "solved" && !terminalRecovery) throw new Error("completed AlphaSolve session has no undelivered recovery work");
				if (latest.solutionExists && !terminalRecovery) throw new Error("solution.md appeared while AlphaSolve was interrupted; request AlphaSolve explicitly to resolve it");
			} else if (!terminalRecovery) {
				if (latest.solutionExists && request.overwriteSolution !== true) throw new ExistingSolutionConfirmationError(snapshot.root);
				if (latest.solutionExists) await backupSolution(snapshot.root);
				if (await archivePreviousGeneration(snapshot.root, latest.problem.digest)) {
					store = new RuntimeStore(snapshot.root);
					opened = await store.open(initialState(agent, latest, activationConfig));
					resumed = false;
					preservePersistedConfig = false;
				}
			}
			throwIfActivationCancelled(signal);
			if (store.currentState().problemDigest !== latest.problem.digest) throw new Error("persisted AlphaSolve state belongs to a different problem generation");
			const persistedConfig = store.currentState();
			const runtimeConfig = preservePersistedConfig ? {
				capacity: request.capacity ?? persistedConfig.capacity,
				detailedTrace: persistedConfig.detailedTrace,
				models: persistedConfig.modelOverrides
			} : activationConfig;
			await store.updateState((state) => {
				const next = {
					...state,
					sessionId: String(agent.id),
					workspace: latest.root,
					status: terminalRecovery ? "solved" : "active",
					capacity: runtimeConfig.capacity,
					detailedTrace: runtimeConfig.detailedTrace,
					modelOverrides: runtimeConfig.models,
					...latest.hint === void 0 ? {} : { hintDigest: latest.hint.digest }
				};
				if (latest.hint !== void 0) return next;
				const { hintDigest: _hint, ...withoutHint } = next;
				return withoutHint;
			});
			throwIfActivationCancelled(signal);
			const roleService = new AlphaSolveRoleService({
				parent: agent,
				workspace: snapshot.root,
				getConfig: () => ({
					capacity: store.currentState().capacity,
					detailedTrace: store.currentState().detailedTrace,
					models: store.currentState().modelOverrides
				}),
				onTrace: async (event) => {
					if (!store.currentState().detailedTrace) return void 0;
					if (curator === void 0) throw new Error("curator is not ready for AlphaSolve traces");
					const traceId = `${event.kind}-${event.agentId}-${randomUUID().slice(0, 8)}`;
					const traceRelative = `.alphasolve/traces/${traceId}.json`;
					await atomicWriteJson(await resolveWorkspacePath(snapshot.root, traceRelative, { mustExist: false }), event);
					if (event.workerId !== void 0) await store.appendWorkerTracePath(event.workerId, traceRelative);
					if (shouldEnqueueCuratorTrace(event)) await curator.submit({
						id: `trace-${traceId}`,
						kind: event.kind === "workflow_role" && event.role === "verifier_premise_chain" ? "verifier_final" : "digest",
						...event.workerId === void 0 ? {} : { sourceWorkerId: event.workerId },
						tracePath: traceRelative,
						metadata: {
							traceKind: event.kind,
							role: String(event.role)
						}
					});
					return traceRelative;
				}
			});
			curator = await DurableCurator.open({
				workspaceRoot: snapshot.root,
				runner: roleService.runCurator,
				onTaskFailure: (task, error) => {
					const conciseError = errorMessage(error).replaceAll(/\s+/g, " ").slice(0, 500);
					agent.inject(createUserMessage({
						content: [{
							type: "text",
							text: `AlphaSolve curator task failed and needs orchestrator attention: id=${task.id}, kind=${task.kind}, error=${conciseError}`
						}],
						source: {
							kind: "plugin",
							plugin: "dsh-alphasolve"
						}
					}));
				},
				drainTimeoutMs: 6e4
			});
			throwIfActivationCancelled(signal);
			const projectTools = await createProjectTools(snapshot.root);
			const executor = createFixedWorkerExecutor({
				workspace: snapshot.root,
				invoker: roleService,
				filenameBuilder: roleService.buildPropositionFilename,
				replaceExistingSolution: request.overwriteSolution === true
			});
			let runtime;
			const manager = new WorkerManager(store, executor, (message) => {
				agent.inject(createUserMessage({
					content: [{
						type: "text",
						text: message
					}],
					source: {
						kind: "plugin",
						plugin: "dsh-alphasolve"
					}
				}));
			}, (error) => {
				agent.ctx.logger.warn(`AlphaSolve background error: ${errorMessage(error)}`);
			}, () => lock.assertOwned(), async () => {
				await curator?.stop();
			});
			runtime = new AlphaSolveRuntime(agent, lock, store, runtimeConfig, curator, roleService, manager, projectTools, request.overwriteSolution === true, terminalRecovery, onDisposed);
			throwIfActivationCancelled(signal);
			return {
				runtime,
				resumed
			};
		} catch (error) {
			const cleanupErrors = [];
			try {
				await curator?.stop();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			try {
				await lock.release();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "AlphaSolve runtime preparation failed and rollback was incomplete", { cause: error });
			throw error;
		}
	}
	/** Prepare resources, then publish all tools/prompt in one agent child fiber. */
	static async activate(agent, request, defaults, onDisposed, signal, mode = "explicit") {
		const prepared = await AlphaSolveRuntime.prepare(agent, request, defaults, onDisposed, signal, mode);
		try {
			throwIfActivationCancelled(signal);
			const fiber = agent.ctx.plugin({
				name: "dsh-alphasolve:session-runtime",
				inject: ["tools", "systemPrompt"],
				apply: (ctx) => prepared.runtime.install(ctx)
			});
			prepared.runtime.fiber = fiber;
			await fiber;
			throwIfActivationCancelled(signal);
			const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent, signal));
			throwIfActivationCancelled(signal);
			if (!assembly.sections.some((section) => section.name === "alphasolve:orchestrator")) throw new AgentPresetPromptConflictError(inspectAlphaSolveAgentCapabilities(agent).agentPreset);
			return prepared;
		} catch (error) {
			try {
				await prepared.runtime.dispose();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "AlphaSolve runtime publication failed and rollback was incomplete", { cause: error });
			}
			throw error;
		}
	}
	visibleAllowedInheritedTools(ctx) {
		return [...ALPHASOLVE_REQUIRED_FILE_TOOLS, ...WEB_TOOLS].filter((name) => ctx.tools.get(name, this.agent) !== void 0);
	}
	narrowedIndexTools(ctx) {
		return ["write", "edit"].flatMap((name) => {
			const definition = ctx.tools.get(name, this.agent);
			return definition === void 0 ? [] : [narrowedIndexTool(definition)];
		});
	}
	install(ctx) {
		ctx.tools.presentAs("native");
		const runtimeTools = this.createRuntimeTools().filter((tool) => !this.terminalRecovery || tool.name === RUNTIME_TOOL_NAMES.wait || tool.name === RUNTIME_TOOL_NAMES.stop);
		const projectTools = this.terminalRecovery ? [] : this.createProjectToolDefinitions();
		const indexTools = this.terminalRecovery ? [] : this.narrowedIndexTools(ctx);
		for (const tool of [
			...runtimeTools,
			...projectTools,
			...indexTools
		]) ctx.tools.register(tool);
		const allowedInherited = this.terminalRecovery ? [] : this.visibleAllowedInheritedTools(ctx);
		const customNames = [...runtimeTools, ...projectTools].map((tool) => tool.name);
		installRolePermissionBoundary(ctx, createRolePolicy("orchestrator", {
			workspace: this.workspace,
			extraAllowedTools: [...customNames, ...allowedInherited]
		}));
		ctx.tools.restrict({ allow: allowedInherited });
		ctx.systemPrompt.section({
			name: "alphasolve:orchestrator",
			order: 50,
			text: this.terminalRecovery ? "AlphaSolve recovered a terminal solution. No new research or file mutation is allowed. Call alphasolve_wait with no arguments as the final action in this turn; it first lets the recovered curator queue drain, then returns any undelivered completion." : `${ORCHESTRATOR_PROMPT}\n\nThe hard worker cap can be changed only with alphasolve_configure. Call alphasolve_wait with no arguments. When a solved completion is returned, that wait call must be your final action in the turn.`
		});
		ctx.systemPrompt.context({
			name: "alphasolve:runtime-state",
			order: 50,
			text: () => {
				const state = this.store.currentState();
				const activeWorkerIds = this.manager.activeIds();
				const activeWorkerProgress = this.manager.activeProgress();
				return [
					"AlphaSolve runtime state (authoritative for this model step):",
					`- status: ${state.status}`,
					`- capacity: ${state.capacity}`,
					`- active: ${activeWorkerIds.length}`,
					`- activeWorkerIds: ${JSON.stringify(activeWorkerIds)}`,
					`- activeWorkerProgress: ${JSON.stringify(activeWorkerProgress)}`,
					`- overCapacity: ${this.manager.overCapacity()}`,
					`- completedSinceResearchReview: ${this.completionsSinceResearchReview.size}`,
					`- researchReviewDue: ${this.completionsSinceResearchReview.size >= 4}`
				].join("\n");
			}
		});
		ctx.on("session/event", (_session, event) => {
			if (event.type !== "tool/result") return;
			this.trackToolResultCommit(event);
		});
		ctx.on("session/flush", async () => {
			await this.flushToolResultCommits();
		});
		ctx.on("agent/status", ({ agent, status }) => {
			if (agent !== this.agent) return;
			this.turnSettled = status === "idle";
			if (this.turnSettled) this.maybeDisposeAfterTerminalResult();
		});
		return async () => {
			try {
				await this.flushToolResultCommits();
			} catch (error) {
				this.agent.ctx.logger.warn(`AlphaSolve completion-delivery flush failed during unload: ${errorMessage(error)}`);
			}
			await this.shutdown(this.store.currentState().status === "solved" ? "solved" : "interrupted");
		};
	}
	trackToolResultCommit(event) {
		const pending = this.onToolResultEvent(event);
		this.pendingSessionCommits.add(pending);
		pending.then(() => this.pendingSessionCommits.delete(pending), (error) => {
			this.pendingSessionCommits.delete(pending);
			this.pendingSessionCommitErrors.push(error);
			this.agent.ctx.logger.warn(`AlphaSolve completion-delivery commit failed: ${errorMessage(error)}`);
		});
	}
	async flushToolResultCommits() {
		while (this.pendingSessionCommits.size > 0) await Promise.allSettled([...this.pendingSessionCommits]);
		const [firstError] = this.pendingSessionCommitErrors.splice(0);
		if (firstError !== void 0) throw firstError;
	}
	createRuntimeTools() {
		return [
			jsonTool({
				name: RUNTIME_TOOL_NAMES.worker,
				description: [
					"Start one asynchronous fixed AlphaSolve proposition worker and return immediately; it never queues or waits when capacity is full.",
					"",
					"The instruction must be one mathematical proposition target or bounded route toward a proposition. A worker may prove a final answer, bridge, auxiliary lemma, construction, obstruction, counterexample, admissible-choice classification, or exact assembly/interface result.",
					"",
					"This is not a general subagent. Never ask it to browse the Web, download literature, write knowledge/, edit verified_propositions/, write solution.md, diagnose the environment, test connectivity, choose its own output path, or bypass the fixed format/workflow.",
					"",
					"Lifecycle: generator writes one proposition.md; five independent verifier profiles must all pass; a completed mathematical failure invokes a fresh reviser and restarts all profiles for at most six rounds; five fresh theorem checks alone decide whether the verified Statement solves problem.md.",
					"",
					"The immediate result reports admission, active workers, capacity, and the worker ID. Use alphasolve_wait to collect lifecycle completions."
				].join("\n"),
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: { instruction: {
						type: "string",
						maxLength: 4e3
					} },
					required: ["instruction"]
				},
				execute: async (args, exec) => {
					if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException("worker start cancelled", "AbortError");
					const record = argumentRecord$1(args, RUNTIME_TOOL_NAMES.worker);
					exactKeys(record, ["instruction"], RUNTIME_TOOL_NAMES.worker);
					return this.manager.start(requiredString(record, "instruction", RUNTIME_TOOL_NAMES.worker));
				}
			}),
			jsonTool({
				name: RUNTIME_TOOL_NAMES.wait,
				description: [
					"Pure wait: start no hidden worker and take no arguments. If no completion backlog exists, wait until at least one active worker completes; then return every completion not delivered by an earlier successful wait plus the current active/capacity snapshot.",
					"",
					"Interpret results by class: verified is established auxiliary progress; rejected is a completed mathematical verification failure; failed is infrastructure/protocol failure and is not evidence that the proposition is false; solved means solution.md was atomically written.",
					"",
					"The result also reports completedSinceResearchReview and researchReviewDue. Run a fresh research review after roughly three to five worker lifecycles. When a solved completion is returned, this wait call must be the final action of the turn."
				].join("\n"),
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {}
				},
				execute: async (args, exec) => {
					exactKeys(argumentRecord$1(args, RUNTIME_TOOL_NAMES.wait), [], RUNTIME_TOOL_NAMES.wait);
					const callId = String(exec.callId);
					this.waitCalls.add(callId);
					try {
						if (this.terminalRecovery) await this.curator.stop();
						const result = await this.manager.wait(callId, exec.signal);
						for (const completion of result.completed) this.completionsSinceResearchReview.add(completion.workerId);
						const enrichedResult = {
							...result,
							completedSinceResearchReview: this.completionsSinceResearchReview.size,
							researchReviewDue: this.completionsSinceResearchReview.size >= 4
						};
						if (result.completed.some((completion) => completion.status === "solved" && completion.solved) || this.terminalRecovery && this.store.currentState().status === "solved") {
							this.solvedWaitCalls.add(callId);
							exec.concludeTurn();
						}
						return enrichedResult;
					} catch (error) {
						await this.store.releaseReservation(callId);
						this.waitCalls.delete(callId);
						throw error;
					}
				}
			}),
			jsonTool({
				name: RUNTIME_TOOL_NAMES.configure,
				description: "Change this session runtime's one hard worker-capacity limit. Lowering it never cancels active workers.",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: { capacity: {
						type: "integer",
						minimum: 1
					} },
					required: ["capacity"]
				},
				execute: async (args, exec) => {
					if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException("configuration cancelled", "AbortError");
					const record = argumentRecord$1(args, RUNTIME_TOOL_NAMES.configure);
					exactKeys(record, ["capacity"], RUNTIME_TOOL_NAMES.configure);
					const capacity = positiveInteger(record.capacity, "capacity");
					const result = await this.manager.configure(capacity);
					this.config = {
						...this.config,
						capacity
					};
					return result;
				}
			}),
			jsonTool({
				name: RUNTIME_TOOL_NAMES.researchReview,
				description: [
					"Run one fresh, read-only AlphaSolve workspace research-progress reviewer over problem.md, actual verified proposition Statements, and exploratory knowledge.",
					"",
					"This is not a Web or literature-download tool and it never inspects live unverified workers. Use it every three to five worker lifecycles, after major verified growth, when routes conflict, or when the best next proposition is unclear. Its optional prompt should name routes or bottlenecks to compare, not ask it to prove or verify new mathematics.",
					"",
					"The reviewer first consumes a compact program-ranked research map, then selectively inspects exact files. It returns established progress, the precise global gap, promising knowledge claims, and one to three ranked next proposition targets."
				].join("\n"),
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: { prompt: {
						type: "string",
						maxLength: 4e3
					} }
				},
				execute: async (args, exec) => {
					const record = argumentRecord$1(args, RUNTIME_TOOL_NAMES.researchReview);
					exactKeys(record, ["prompt"], RUNTIME_TOOL_NAMES.researchReview);
					const prompt = optionalString(record, "prompt", RUNTIME_TOOL_NAMES.researchReview);
					const review = await this.roleService.runResearchReview({
						signal: exec.signal,
						...prompt === void 0 ? {} : { prompt }
					});
					this.completionsSinceResearchReview.clear();
					return { review };
				}
			}),
			jsonTool({
				name: RUNTIME_TOOL_NAMES.stop,
				description: "Explicitly stop and unload AlphaSolve for this session, preserving all research and durable completion data.",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {}
				},
				execute: async (args, exec) => {
					exactKeys(argumentRecord$1(args, RUNTIME_TOOL_NAMES.stop), [], RUNTIME_TOOL_NAMES.stop);
					this.stopCallId = String(exec.callId);
					await this.shutdown("cancelled", false);
					exec.concludeTurn();
					return {
						stopped: true,
						workspace: this.workspace
					};
				}
			})
		];
	}
	createProjectToolDefinitions() {
		return [
			jsonTool({
				name: PROJECT_TOOL_NAMES.mkdir,
				description: "Create one topic-directory chain below verified_propositions/.",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: { path: {
						type: "string",
						pattern: VERIFIED_SUBDIRECTORY_PATH_PATTERN
					} },
					required: ["path"]
				},
				execute: async (args, exec) => {
					if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException("mkdir cancelled", "AbortError");
					const record = argumentRecord$1(args, PROJECT_TOOL_NAMES.mkdir);
					exactKeys(record, ["path"], PROJECT_TOOL_NAMES.mkdir);
					await this.lock.assertOwned();
					if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException("mkdir cancelled", "AbortError");
					return this.projectTools.mkdir(requiredString(record, "path", PROJECT_TOOL_NAMES.mkdir));
				}
			}),
			jsonTool({
				name: PROJECT_TOOL_NAMES.rename,
				description: "Rename one verified proposition Markdown file or topic directory in place. index.md is protected and proposition references are updated atomically.",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						directory: {
							type: "string",
							pattern: VERIFIED_DIRECTORY_PATH_PATTERN
						},
						old_name: {
							type: "string",
							pattern: VERIFIED_RENAME_NAME_PATTERN
						},
						new_name: {
							type: "string",
							pattern: VERIFIED_RENAME_NAME_PATTERN
						}
					},
					required: [
						"directory",
						"old_name",
						"new_name"
					]
				},
				execute: async (args, exec) => {
					if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException("rename cancelled", "AbortError");
					const record = argumentRecord$1(args, PROJECT_TOOL_NAMES.rename);
					exactKeys(record, [
						"directory",
						"old_name",
						"new_name"
					], PROJECT_TOOL_NAMES.rename);
					await this.lock.assertOwned();
					if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException("rename cancelled", "AbortError");
					return this.projectTools.rename(requiredString(record, "directory", PROJECT_TOOL_NAMES.rename), requiredString(record, "old_name", PROJECT_TOOL_NAMES.rename), requiredString(record, "new_name", PROJECT_TOOL_NAMES.rename));
				}
			}),
			jsonTool({
				name: PROJECT_TOOL_NAMES.move,
				description: "Move one existing verified proposition Markdown file into an existing verified topic directory while preserving its file name. index.md is protected and proposition references are updated atomically.",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						path: {
							type: "string",
							pattern: VERIFIED_MARKDOWN_PATH_PATTERN
						},
						destination_dir: {
							type: "string",
							pattern: VERIFIED_DIRECTORY_PATH_PATTERN
						}
					},
					required: ["path", "destination_dir"]
				},
				execute: async (args, exec) => {
					if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException("move cancelled", "AbortError");
					const record = argumentRecord$1(args, PROJECT_TOOL_NAMES.move);
					exactKeys(record, ["path", "destination_dir"], PROJECT_TOOL_NAMES.move);
					await this.lock.assertOwned();
					if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException("move cancelled", "AbortError");
					return this.projectTools.moveInto(requiredString(record, "path", PROJECT_TOOL_NAMES.move), requiredString(record, "destination_dir", PROJECT_TOOL_NAMES.move));
				}
			})
		];
	}
	async onToolResultEvent(event) {
		const callId = String(event.data.message.source.callId);
		if (this.waitCalls.has(callId)) try {
			if (successfulToolResult(event)) await this.store.commitDelivery(callId);
			else await this.store.releaseReservation(callId);
			if (successfulToolResult(event) && this.solvedWaitCalls.has(callId)) this.solvedResultCommitted = true;
		} finally {
			this.waitCalls.delete(callId);
		}
		if (callId === this.stopCallId && successfulToolResult(event)) this.stopResultCommitted = true;
		this.maybeDisposeAfterTerminalResult();
	}
	maybeDisposeAfterTerminalResult() {
		if (!this.turnSettled || !this.solvedResultCommitted && !this.stopResultCommitted) return;
		const fiber = this.fiber;
		if (fiber !== void 0) fiber.dispose().catch((error) => {
			this.agent.ctx.logger.warn(`AlphaSolve runtime unload failed: ${errorMessage(error)}`);
		});
	}
	/** Release workspace ownership and always detach this runtime from its controller. */
	async releaseOwnership() {
		try {
			await this.lock.release();
		} finally {
			if (!this.disposed) {
				this.disposed = true;
				this.onDisposed();
			}
		}
	}
	async shutdown(kind, releaseLock = true) {
		if (this.shutdownPromise !== void 0) {
			try {
				await this.shutdownPromise;
			} finally {
				if (releaseLock) await this.releaseOwnership();
			}
			return;
		}
		this.shutdownPromise = (async () => {
			if (this.store.currentState().status !== "solved") await this.store.updateState((state) => ({
				...state,
				status: "stopping"
			}));
			await this.manager.stop(kind === "cancelled" ? "cancelled" : "interrupted");
			await this.curator.stop();
			if (this.store.currentState().status !== "solved") await this.store.updateState((state) => ({
				...state,
				status: "interrupted"
			}));
		})();
		try {
			await this.shutdownPromise;
		} finally {
			if (releaseLock) await this.releaseOwnership();
		}
	}
	/** Dispose the published session fiber, or the prepared resources on startup failure. */
	async dispose() {
		if (this.fiber !== void 0) await this.fiber.dispose();
		else await this.shutdown("interrupted");
	}
};
var ExistingSolutionConfirmationError = class extends Error {
	workspace;
	constructor(workspace) {
		super("solution.md already exists; ask the user for explicit overwrite authorization before activating AlphaSolve");
		this.workspace = workspace;
		this.name = "ExistingSolutionConfirmationError";
	}
};
var AgentPresetPromptConflictError = class extends Error {
	agentPreset;
	constructor(agentPreset) {
		super(AGENT_PRESET_BLOCKS_PROMPT_REASON);
		this.agentPreset = agentPreset;
		this.name = "AgentPresetPromptConflictError";
	}
};
/** Convert activation failures into a stable preflight tool result. */
async function activateAlphaSolveRuntime(agent, request, defaults, onDisposed, signal) {
	const workspace = agent.session.header.cwd ?? "";
	try {
		throwIfActivationCancelled(signal);
		const capabilities = inspectAlphaSolveAgentCapabilities(agent);
		if (capabilities.missingTools.length > 0) return {
			activated: false,
			workspace,
			reason: AGENT_PRESET_MISSING_TOOLS_REASON,
			...capabilities.agentPreset === void 0 ? {} : { agentPreset: capabilities.agentPreset },
			missingTools: capabilities.missingTools
		};
		const { runtime, resumed } = await AlphaSolveRuntime.activate(agent, request, defaults, onDisposed, signal);
		return {
			activated: true,
			workspace: runtime.workspace,
			capacity: runtime.store.currentState().capacity,
			resumed,
			runtime
		};
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		if (error instanceof ExistingSolutionConfirmationError) return {
			activated: false,
			workspace: error.workspace,
			reason: "solution_exists_confirmation_required"
		};
		if (error instanceof AgentPresetPromptConflictError) return {
			activated: false,
			workspace,
			reason: AGENT_PRESET_BLOCKS_PROMPT_REASON,
			...error.agentPreset === void 0 ? {} : { agentPreset: error.agentPreset }
		};
		return {
			activated: false,
			workspace,
			reason: errorMessage(error)
		};
	}
}
/**
* Reattach a runtime only when the selected workspace carries durable active
* intent for this exact resumed session. This is recovery, never a new
* activation: it cannot archive a generation or authorize solution overwrite.
*/
async function restoreAlphaSolveRuntime(agent, defaults, onDisposed, signal) {
	const workspace = agent.session.header.cwd ?? "";
	try {
		throwIfActivationCancelled(signal);
		const probe = await probeRuntimeRestore(agent);
		throwIfActivationCancelled(signal);
		if (!probe.candidate) return {
			restored: false,
			workspace: probe.workspace,
			...probe.reason === void 0 ? {} : { reason: probe.reason }
		};
		const capabilities = inspectAlphaSolveAgentCapabilities(agent);
		if (capabilities.missingTools.length > 0) return {
			restored: false,
			workspace: probe.workspace,
			reason: AGENT_PRESET_MISSING_TOOLS_REASON,
			...capabilities.agentPreset === void 0 ? {} : { agentPreset: capabilities.agentPreset },
			missingTools: capabilities.missingTools
		};
		const { runtime } = await AlphaSolveRuntime.activate(agent, {}, defaults, onDisposed, signal, "session-resume");
		return {
			restored: true,
			workspace: runtime.workspace,
			capacity: runtime.store.currentState().capacity,
			runtime
		};
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		if (error instanceof AgentPresetPromptConflictError) return {
			restored: false,
			workspace,
			reason: AGENT_PRESET_BLOCKS_PROMPT_REASON,
			...error.agentPreset === void 0 ? {} : { agentPreset: error.agentPreset }
		};
		return {
			restored: false,
			workspace,
			reason: errorMessage(error)
		};
	}
}
//#endregion
//#region src/controller.ts
const ACTIVATE_TOOL_NAME = "alphasolve_activate";
const PREFLIGHT_PROMPT = `A direct user message mentioned AlphaSolve. Decide from that direct message whether the user affirmatively asks you to solve the current workspace's problem.md in the AlphaSolve way.

This is only a one-turn preflight; do not activate for explanations, comparisons, quoted text, negation, or discussion about AlphaSolve itself. If there is no affirmative solve intent, answer normally and do not call alphasolve_activate.

For an affirmative solve request:
1. Check problem.md in the session workspace. It must exist, be a non-empty ordinary UTF-8 file, and stay inside the selected workspace. hint.md is optional. If problem.md is absent or invalid, explain that directly and do not activate.
2. Check whether solution.md already exists. Even if you inspect it first, call alphasolve_activate once with overwriteSolution=false so the plugin can perform the authoritative race-safe check. If it reports solution_exists_confirmation_required, ask the user whether this activation may back up and overwrite solution.md. Do not infer authorization from an earlier activation or from vague agreement.
3. Pass a positive integer capacity only when this direct request explicitly specifies the maximum worker count. Otherwise omit it; project/user/default precedence applies.
4. After the user explicitly authorizes overwrite, call alphasolve_activate with overwriteSolution=true. The confirmation turn does not need to repeat the AlphaSolve keyword.

If activation reports agent_preset_missing_required_tools, explain which tools are missing and ask the user to use an Agent preset that provides the standard read/write/edit/glob/grep filesystem tools. Do not attempt to widen the preset yourself.

If activation reports agent_preset_blocks_alphasolve_prompt, explain that the selected preset enforces a complete system prompt which suppresses the AlphaSolve workflow instructions, and ask the user to choose standard, cordis, code, or a compatible custom preset.

Never use bash or arbitrary code to perform these checks.`;
function messageText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
/** Strict dormant trigger: direct human source plus whole ASCII word, case-insensitive. */
function requestsAlphaSolvePreflight(message) {
	return message.source.kind === "user" && /\balphasolve\b/i.test(messageText(message));
}
/** Subagent/fork sessions never receive the dormant trigger controller. */
function isTopLevelAgent(agent) {
	return agent.session.header.parentSession === void 0 && agent.session.header.origin !== "subagent";
}
function argumentRecord(args) {
	if (args === null || typeof args !== "object" || Array.isArray(args)) throw new TypeError(`${ACTIVATE_TOOL_NAME} arguments must be an object`);
	return args;
}
function activationRequest(args) {
	const record = argumentRecord(args);
	const unexpected = Object.keys(record).filter((key) => key !== "capacity" && key !== "overwriteSolution");
	if (unexpected.length > 0) throw new TypeError(`${ACTIVATE_TOOL_NAME} received unexpected argument ${unexpected[0]}`);
	const capacity = record.capacity;
	if (capacity !== void 0 && (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity < 1)) throw new TypeError("alphasolve_activate.capacity must be a positive safe integer");
	if (record.overwriteSolution !== void 0 && typeof record.overwriteSolution !== "boolean") throw new TypeError("alphasolve_activate.overwriteSolution must be a boolean");
	return {
		...capacity === void 0 ? {} : { capacity },
		...record.overwriteSolution === void 0 ? {} : { overwriteSolution: record.overwriteSolution }
	};
}
function publicActivationResult(result) {
	return {
		activated: result.activated,
		workspace: result.workspace,
		...result.reason === void 0 ? {} : { reason: result.reason },
		...result.capacity === void 0 ? {} : { capacity: result.capacity },
		...result.resumed === void 0 ? {} : { resumed: result.resumed },
		...result.agentPreset === void 0 ? {} : { agentPreset: result.agentPreset },
		...result.missingTools === void 0 ? {} : { missingTools: [...result.missingTools] }
	};
}
/** Owns every dynamic child fiber created by the otherwise dormant plugin. */
var AlphaSolveController = class {
	ctx;
	options;
	states = /* @__PURE__ */ new Map();
	activate;
	restore;
	constructor(ctx, options = {}) {
		this.ctx = ctx;
		this.options = options;
		this.activate = options.activate ?? activateAlphaSolveRuntime;
		this.restore = options.restore ?? restoreAlphaSolveRuntime;
	}
	install() {
		this.ctx.on("agent/session-start", ({ agent, source }) => {
			if (source !== "resume" || this.states.has(agent) || !isTopLevelAgent(agent)) return;
			this.beginRestore(agent);
		});
		this.ctx.on("agent/inbox/claimed", ({ agent, message }) => {
			if (this.states.has(agent)) return;
			if (!isTopLevelAgent(agent) || !requestsAlphaSolvePreflight(message)) return;
			this.mountPreflight(agent);
		});
		this.ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
			const current = this.states.get(agent);
			if (current?.kind === "runtime") return next();
			if (current?.kind === "preflight") {
				if (current.awaitingConfirmation && messages.some((message) => message.source.kind === "user")) current.confirmationResponseStarted = true;
				try {
					const decision = await next();
					signal.throwIfAborted();
					if (decision.kind === "reject") await this.disposePreflight(agent, current);
					return decision;
				} catch (error) {
					await this.disposePreflight(agent, current);
					throw error;
				}
			}
			return next();
		});
		this.ctx.on("agent/status", ({ agent, status }) => {
			if (status !== "idle") return;
			const state = this.states.get(agent);
			if (state?.kind !== "preflight") return;
			if (!state.awaitingConfirmation || state.confirmationResponseStarted) this.disposePreflight(agent, state);
		});
		this.ctx.on("agent/disposed", async ({ agent }) => {
			const state = this.states.get(agent);
			this.states.delete(agent);
			if (state?.kind === "preflight") state.dispose();
			else if (state?.kind === "runtime") await state.runtime.dispose();
			else if (state?.kind === "restoring") state.abort.abort(/* @__PURE__ */ new Error("AlphaSolve restoring agent was disposed"));
		});
		return async () => {
			const states = [...this.states.entries()];
			this.states.clear();
			for (const [, state] of states) if (state.kind === "restoring") state.abort.abort(/* @__PURE__ */ new Error("AlphaSolve controller was disposed"));
			await Promise.allSettled(states.map(([, state]) => {
				if (state.kind === "preflight") return Promise.resolve(state.dispose());
				if (state.kind === "runtime") return state.runtime.dispose();
				return state.done ?? Promise.resolve();
			}));
		};
	}
	beginRestore(agent) {
		const state = {
			kind: "restoring",
			abort: new AbortController()
		};
		this.states.set(agent, state);
		try {
			state.done = agent.runMaintenance(async (agentSignal) => {
				const signal = AbortSignal.any([agentSignal, state.abort.signal]);
				let runtimeRef;
				try {
					const result = await this.restore(agent, {
						...this.options.defaultCapacity === void 0 ? {} : { defaultCapacity: this.options.defaultCapacity },
						...this.options.defaultDetailedTrace === void 0 ? {} : { defaultDetailedTrace: this.options.defaultDetailedTrace }
					}, () => {
						const current = this.states.get(agent);
						if (current?.kind === "runtime" && current.runtime === runtimeRef) this.states.delete(agent);
					}, signal);
					if (signal.aborted) {
						if (result.restored) await result.runtime.dispose();
						throw signal.reason ?? new DOMException("AlphaSolve session recovery cancelled", "AbortError");
					}
					if (this.states.get(agent) !== state) {
						if (result.restored) await result.runtime.dispose();
						return;
					}
					if (!result.restored) {
						this.states.delete(agent);
						if (result.reason !== void 0) this.injectRestoreDiagnostic(agent, result);
						return;
					}
					runtimeRef = result.runtime;
					this.states.set(agent, {
						kind: "runtime",
						runtime: result.runtime
					});
				} catch (error) {
					if (this.states.get(agent) !== state) return;
					this.states.delete(agent);
					if (!signal.aborted) this.injectRestoreDiagnostic(agent, error instanceof Error ? error.message : String(error));
				}
			});
			state.done.catch((error) => {
				if (this.states.get(agent) !== state) return;
				this.states.delete(agent);
				if (!state.abort.signal.aborted) this.injectRestoreDiagnostic(agent, error instanceof Error ? error.message : String(error));
			});
		} catch (error) {
			if (this.states.get(agent) === state) this.states.delete(agent);
			this.injectRestoreDiagnostic(agent, error instanceof Error ? error.message : String(error));
		}
	}
	injectRestoreDiagnostic(agent, failure) {
		let reason = typeof failure === "string" ? failure : failure.reason ?? "unknown recovery failure";
		if (typeof failure !== "string" && failure.reason === "agent_preset_missing_required_tools" && failure.missingTools !== void 0) {
			const owner = failure.agentPreset === void 0 ? "the current Agent composition" : `Agent preset "${failure.agentPreset}"`;
			reason = `${failure.reason}: ${owner} is missing ${failure.missingTools.join(", ")}`;
		} else if (typeof failure !== "string" && failure.reason === "agent_preset_blocks_alphasolve_prompt") {
			const owner = failure.agentPreset === void 0 ? "the current Agent composition" : `Agent preset "${failure.agentPreset}"`;
			reason = `${failure.reason}: ${owner} suppresses the AlphaSolve workflow prompt`;
		}
		const concise = reason.replaceAll(/\s+/g, " ").slice(0, 500);
		agent.inject(createUserMessage({
			content: [{
				type: "text",
				text: `AlphaSolve could not restore this resumed session automatically: ${concise}. The runtime remains dormant; ask explicitly with the AlphaSolve keyword after resolving the problem.`
			}],
			source: {
				kind: "plugin",
				plugin: "dsh-alphasolve"
			}
		}));
	}
	mountPreflight(agent) {
		const disposers = [];
		let disposed = false;
		let nativePresentation;
		let inheritedRestriction;
		const ctx = agent.ctx;
		const capabilities = inspectAlphaSolveAgentCapabilities(agent);
		const allowedInherited = ["read"].filter((name) => ctx.tools.get(name, agent) !== void 0);
		const resumeToolIsolation = () => {
			if (disposed) throw new Error("cannot reacquire AlphaSolve preflight presentation after disposal");
			nativePresentation ??= ctx.tools.presentAs("native");
			inheritedRestriction ??= ctx.tools.restrict({ allow: allowedInherited });
		};
		const suspendToolIsolation = () => {
			const disposeRestriction = inheritedRestriction;
			inheritedRestriction = void 0;
			disposeRestriction?.();
			const disposePresentation = nativePresentation;
			nativePresentation = void 0;
			disposePresentation?.();
		};
		const state = {
			kind: "preflight",
			resumeToolIsolation,
			suspendToolIsolation,
			...capabilities.agentPreset === void 0 ? {} : { agentPreset: capabilities.agentPreset },
			missingRequiredTools: capabilities.missingTools,
			awaitingConfirmation: false,
			confirmationResponseStarted: false,
			dispose: () => {
				if (disposed) return;
				disposed = true;
				suspendToolIsolation();
				for (const dispose of disposers.splice(0).reverse()) dispose();
			}
		};
		this.states.set(agent, state);
		try {
			resumeToolIsolation();
			disposers.push(ctx.systemPrompt.section({
				name: "alphasolve:preflight",
				order: 50,
				text: PREFLIGHT_PROMPT
			}));
			disposers.push(ctx.tools.register(this.activationTool(agent, state)));
			const allowed = /* @__PURE__ */ new Set([ACTIVATE_TOOL_NAME, ...allowedInherited]);
			disposers.push(ctx.tools.guard((execution) => allowed.has(execution.name) ? void 0 : `tool "${execution.name}" is unavailable during AlphaSolve preflight`));
			return state;
		} catch (error) {
			if (this.states.get(agent) === state) this.states.delete(agent);
			try {
				state.dispose();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "AlphaSolve preflight setup and rollback failed");
			}
			throw error;
		}
	}
	activationTool(agent, state) {
		return {
			name: ACTIVATE_TOOL_NAME,
			description: "Activate the full session-scoped AlphaSolve runtime after affirmative solve-intent and workspace preflight checks.",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					capacity: {
						type: "integer",
						minimum: 1
					},
					overwriteSolution: { type: "boolean" }
				}
			},
			output: {
				schema: { type: "object" },
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value, null, 2)
				}]
			},
			execute: async (args, exec) => {
				if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException("AlphaSolve activation cancelled", "AbortError");
				if (this.states.get(agent) !== state) throw new Error("AlphaSolve preflight is no longer active");
				const request = activationRequest(args);
				if (state.missingRequiredTools.length > 0) return {
					activated: false,
					workspace: agent.session.header.cwd ?? "",
					reason: AGENT_PRESET_MISSING_TOOLS_REASON,
					...state.agentPreset === void 0 ? {} : { agentPreset: state.agentPreset },
					missingTools: [...state.missingRequiredTools]
				};
				if (request.overwriteSolution === true && (!state.awaitingConfirmation || !state.confirmationResponseStarted)) return {
					activated: false,
					workspace: agent.session.header.cwd ?? "",
					reason: "overwrite_confirmation_not_established"
				};
				let runtimeRef;
				state.suspendToolIsolation();
				let result;
				try {
					result = await this.activate(agent, request, {
						...this.options.defaultCapacity === void 0 ? {} : { defaultCapacity: this.options.defaultCapacity },
						...this.options.defaultDetailedTrace === void 0 ? {} : { defaultDetailedTrace: this.options.defaultDetailedTrace }
					}, () => {
						const current = this.states.get(agent);
						if (current?.kind === "runtime" && current.runtime === runtimeRef) this.states.delete(agent);
					}, exec.signal);
				} catch (error) {
					if (!exec.signal.aborted) state.resumeToolIsolation();
					throw error;
				}
				if (exec.signal.aborted) {
					if (result.activated) await result.runtime.dispose();
					throw exec.signal.reason ?? new DOMException("AlphaSolve activation cancelled", "AbortError");
				}
				if (!result.activated) {
					state.resumeToolIsolation();
					if (result.reason === "solution_exists_confirmation_required") {
						state.awaitingConfirmation = true;
						state.confirmationResponseStarted = false;
					}
					return publicActivationResult(result);
				}
				runtimeRef = result.runtime;
				this.states.set(agent, {
					kind: "runtime",
					runtime: result.runtime
				});
				state.dispose();
				return publicActivationResult(result);
			}
		};
	}
	async disposePreflight(agent, state) {
		if (this.states.get(agent) !== state) return;
		this.states.delete(agent);
		state.dispose();
	}
};
//#endregion
//#region src/index.ts
const name = "dsh-alphasolve";
const inject = [
	"agents",
	"tools",
	"systemPrompt"
];
const Config = z.object({
	defaultCapacity: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(2),
	defaultDetailedTrace: z.boolean().default(true)
});
/** Install only the dormant trigger listener. It contributes no global tool or prompt. */
function apply(ctx, config = {}) {
	return new AlphaSolveController(ctx, {
		defaultCapacity: config.defaultCapacity ?? 2,
		defaultDetailedTrace: config.defaultDetailedTrace ?? true
	}).install();
}
//#endregion
export { ACTIVATE_TOOL_NAME, AGENT_PRESET_BLOCKS_PROMPT_REASON, AGENT_PRESET_MISSING_TOOLS_REASON, ALPHASOLVE_REQUIRED_FILE_TOOLS, AlphaSolveController, AlphaSolveRuntime, Config, MODEL_ROLES, RUNTIME_TOOL_NAMES, STATE_VERSION, VERIFIER_PROFILES, activateAlphaSolveRuntime, apply, archivePreviousGeneration, hasDurableAlphaSolveResumeIntent, inject, inspectAlphaSolveAgentCapabilities, isTopLevelAgent, name, requestsAlphaSolvePreflight, restoreAlphaSolveRuntime, shouldEnqueueCuratorTrace };
