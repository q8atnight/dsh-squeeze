// dsh-squeeze — tool `squeeze` for DeepSeek Harness.
//
// Reads a long web page, a batch of pages or a text file, hands it with ONE question to a helper
// model chosen in the plugin's setup page, and returns only the answer, so the material never
// fills the main conversation.
//
// - Models come from the DSH model list (Plugins → squeeze → Configure): a default plus up to two
//   extra, each with a nickname, a fixed thinking level and a "when to use" note. The agent picks a
//   model by nickname; it cannot choose the thinking level.
// - The per-call size limit follows each model's context window (fill share is a setting).
// - Optional fallback walks the model list when a model is down or the material is too big for it.
// - One call at a time; every failure is reported as a plain sentence with a next step.
//
// Host half only needs Node built-ins plus DSH's own schema library (resolved from the DSH
// installation). The settings page lives in client.js.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import z from "./vendor/schemastery.js";

export const name = "dsh-squeeze";
export const inject = ["tools", "workingDirectory", "llm"];

export const MAX_MODELS = 3;
const NICKNAME = /^[a-z][a-z0-9-]{0,19}$/;

const ModelSlot = z.object({
	nickname: z.string().pattern(NICKNAME).required(),
	provider: z.string().min(1).required(),
	model: z.string().min(1).required(),
	reasoningEffort: z.string().default(""),
	whenToUse: z.string().default(""),
});

export const Config = z.object({
	models: z.array(ModelSlot).default([]).volatile(),
	fallback: z.boolean().default(false).volatile(),
	contextFillPercent: z.number().step(1).min(10).max(95).default(80).volatile(),
	outputTokens: z.number().step(1).min(1000).default(16000).volatile(),
	callTimeoutSeconds: z.number().step(1).min(30).default(600).volatile(),
	fetchTimeoutSeconds: z.number().step(1).min(5).default(30).volatile(),
	maxUrls: z.number().step(1).min(1).max(50).default(20).volatile(),
	maxAnswerChars: z.number().step(1).min(500).default(6000).volatile(),
	minPageChars: z.number().step(1).min(0).default(300).volatile(),
	shortPages: z.union(["return", "refuse"]).default("return").volatile(),
});

// Rough text-to-token conversion for the size check and the description. Latin text ~3.5 chars per
// token measured 2.7–3.9 (tables lowest); CJK ideographs/kana/hangul ~1 token each. Deliberately pessimistic.
const LATIN_CHARS_PER_TOKEN = 3.0;
const PROMPT_OVERHEAD_TOKENS = 1200;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const FILE_ALIASES = ["file_path", "path", "filePath"];
const KNOWN_ARGS = ["prompt", "url", "urls", "file", "model", ...FILE_ALIASES];
const IGNORED_ARGS = ["effort", "reasoning_effort", "thinking"];

// ---------- errors the agent can act on ----------

/** One failure kind per situation; the message always ends with what to do next. */
export class SqueezeError extends Error {
	constructor(kind, message) {
		super(`squeeze ${kind}: ${message}`);
		this.kind = kind;
	}
}
const KIND = {
	request: "REQUEST PROBLEM", // the call itself was wrong — fix the arguments
	source: "SOURCE PROBLEM", // the page/file could not be used
	tooBig: "TOO BIG", // material over the model's limit
	modelDown: "MODEL UNAVAILABLE", // model unreachable / server error / not configured
	noAnswer: "NO ANSWER", // model ran but produced nothing usable
	timeout: "TIMED OUT",
	cancelled: "CANCELLED",
};
const err = (kind, message) => new SqueezeError(kind, message);

// ---------- settings ----------

function readSettings(config) {
	const v = (key, fallback) => {
		const ref = config?.[key];
		const value = ref && typeof ref.get === "function" ? ref.get() : ref;
		return value === undefined ? fallback : value;
	};
	const slots = (v("models", []) ?? []).slice(0, MAX_MODELS).map((m) => ({ ...m, reasoningEffort: m.reasoningEffort ?? "", whenToUse: (m.whenToUse ?? "").trim() }));
	return {
		models: slots,
		fallback: v("fallback", false) === true,
		contextFillPercent: v("contextFillPercent", 80),
		outputTokens: v("outputTokens", 16000),
		callTimeoutMs: v("callTimeoutSeconds", 600) * 1000,
		fetchTimeoutMs: v("fetchTimeoutSeconds", 30) * 1000,
		maxUrls: v("maxUrls", 20),
		maxAnswerChars: v("maxAnswerChars", 6000),
		minPageChars: v("minPageChars", 300),
		shortPages: v("shortPages", "return"),
	};
}

/** The configured slots, or DSH's default chat model when nothing is set up yet. */
function effectiveSlots(ctx, settings) {
	if (settings.models.length > 0) return settings.models;
	const selection = ctx.get?.("agentDefaultModel", false)?.currentSelection?.();
	if (selection?.provider && selection?.model) {
		return [{ nickname: "default", provider: selection.provider, model: selection.model, reasoningEffort: "", whenToUse: "", implicit: true }];
	}
	return [];
}

// ---------- model facts (context window, display name) ----------

const modelFacts = new Map(); // "provider\0model" -> { name, contextWindow, maxTokens, efforts } | { missing: reason }
const key = (slot) => `${slot.provider}\0${slot.model}`;

async function loadFacts(ctx, slot, signal) {
	try {
		const providers = ctx.llm.listProviders?.() ?? [];
		if (providers.length && !providers.some((p) => (p.id ?? p) === slot.provider)) {
			return { missing: `provider "${slot.provider}" is not in the DSH model list` };
		}
		const info = await ctx.llm.resolveModelInfo(slot.provider, slot.model, signal);
		return {
			name: info.name ?? slot.model,
			contextWindow: info.context?.contextWindow,
			maxTokens: info.defaultMaxTokens,
			efforts: info.reasoning?.efforts?.map((e) => e.id) ?? [],
		};
	} catch (e) {
		return { missing: e?.message ?? String(e) };
	}
}

async function refreshFacts(ctx, slots) {
	await Promise.all(slots.map(async (slot) => modelFacts.set(key(slot), await loadFacts(ctx, slot))));
}

/** Token budget for the material itself on this model; undefined when the window is unknown. */
function materialTokenBudget(settings, facts) {
	if (!facts?.contextWindow) return undefined;
	const usable = Math.floor((facts.contextWindow * settings.contextFillPercent) / 100);
	return Math.max(0, usable - outputBudget(settings, facts) - PROMPT_OVERHEAD_TOKENS);
}

function outputBudget(settings, facts) {
	return facts?.maxTokens ? Math.min(settings.outputTokens, facts.maxTokens) : settings.outputTokens;
}

/** Estimated tokens for a text: CJK characters count one each, everything else ~3 chars a token. */
export function estimateTokens(text) {
	let cjk = 0;
	for (const ch of text) {
		const c = ch.codePointAt(0);
		if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x20000 && c <= 0x2fa1f)) cjk++;
	}
	return Math.ceil(cjk + (text.length - cjk) / LATIN_CHARS_PER_TOKEN);
}

const fmt = (n) => Number(n).toLocaleString("en-US");
const roughChars = (tokens) => {
	const chars = tokens * LATIN_CHARS_PER_TOKEN;
	return chars >= 100_000 ? `${fmt(Math.floor(chars / 10_000) * 10_000)}` : fmt(Math.floor(chars / 1000) * 1000);
};

// ---------- model-facing description ----------

export function buildDescription(settings, slots, factsOf) {
	const lines = [
		"Preferred way to read large material without filling this chat. Reads a long web page, several pages at once" +
			` (up to ${settings.maxUrls}) or a text file (report, log, CSV/JSON, code, transcript), gives it with your question to a helper model and returns only the answer.` +
			" Use it before Read or web_fetch on anything long." +
			(pdfSupport()
				? " Text and text PDFs only (PDF links and PDF files are converted automatically); convert Word/Excel to text first; not for scans, images or pages that need JavaScript."
				: " Text only: convert PDF/Word/Excel to text first; not for scans, images or pages that need JavaScript.") +
			" Ask a specific question (what, which section, which figures). Treat answers as leads and check important figures against the source.",
	];
	if (slots.length === 0) {
		lines.push("No helper model is set up yet (Plugins → squeeze → Configure); calls will fail until one is.");
		return lines.join("\n");
	}
	lines.push(slots.length > 1 ? "Helper models — choose one with `model` (nickname); omit it for the default:" : "Helper model:");
	slots.forEach((slot, i) => {
		const facts = factsOf(slot);
		const budget = materialTokenBudget(settings, facts);
		const limit = budget === undefined ? "size limit unknown" : `max ~${roughChars(budget)} characters per call`;
		const label = slot.implicit ? `${slot.nickname} (the DSH default model, ${facts?.name ?? slot.model})` : `${slot.nickname}${i === 0 ? " (default)" : ""}`;
		const note = slot.whenToUse ? ` — ${slot.whenToUse.replace(/\s+/g, " ")}` : "";
		lines.push(`- ${label}${note} [${limit}]`);
	});
	if (slots.length > 1) {
		lines.push(
			settings.fallback
				? "Fallback is on: if the chosen model is unreachable or the material is too big for it, the next model in this list is tried automatically; the status line says which model answered."
				: "Fallback is off: if the chosen model fails, the error says why; you may retry with another model.",
		);
	}
	return lines.join("\n");
}

// ---------- web pages and files -> plain text ----------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", euro: "€", pound: "£", copy: "©", reg: "®", trade: "™", deg: "°", times: "×", middot: "·", bull: "•", laquo: "«", raquo: "»", shy: "" };

function decodeEntities(s) {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
		if (e[0] === "#") {
			const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
		}
		return ENTITIES[e.toLowerCase()] ?? m;
	});
}

/** HTML -> readable text. Keeps headings (#), list items (-) and table rows (| cell | cell |). */
export function htmlToText(html) {
	let s = html;
	s = s.replace(/<!--[\s\S]*?-->/g, " ");
	s = s.replace(/<(script|style|noscript|svg|template|head|iframe|canvas|object|button|select)\b[\s\S]*?<\/\1\s*>/gi, " ");
	s = s.replace(/data:[a-z/+.-]*;base64,[a-z0-9+/=]+/gi, " ");
	s = s.replace(/<h([1-6])\b[^>]*>/gi, (_m, n) => "\n\n" + "#".repeat(Number(n)) + " ");
	s = s.replace(/<tr\b[^>]*>/gi, "\n| ");
	s = s.replace(/<\/t[dh]\s*>/gi, " | ");
	s = s.replace(/<li\b[^>]*>/gi, "\n- ");
	s = s.replace(/<br\s*\/?>/gi, "\n");
	s = s.replace(/<\/(p|div|section|article|header|footer|main|aside|nav|ul|ol|dl|table|thead|tbody|tfoot|tr|h[1-6]|blockquote|pre|dd|dt|figure|figcaption|form|label|caption|details|summary)\s*>/gi, "\n");
	s = s.replace(/<[^>]+>/g, " ");
	s = decodeEntities(s);
	const lines = s.split("\n").map((l) => l.replace(/[ \t\u00a0\u200b]+/g, " ").trim());
	const out = [];
	for (const l of lines) {
		if (l === "" || /^\|[\s|]*$/.test(l)) {
			if (out.length && out[out.length - 1] !== "") out.push("");
			continue;
		}
		out.push(l);
	}
	return out.join("\n").trim();
}

const looksLikeHtml = (t) => /^\s*(<!doctype html|<html|<head|<body|<\?xml[^>]*>\s*<html)/i.test(t) || (/^\s*</.test(t) && /<\/(div|p|body|table|span)>/i.test(t.slice(0, 50_000)));

function decodeBody(buf, contentType) {
	const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
	const sniff = !charset && /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString("latin1"))?.[1];
	try {
		return new TextDecoder(charset || sniff || "utf-8").decode(buf);
	} catch {
		return new TextDecoder("utf-8").decode(buf);
	}
}

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 dsh-squeeze";
const ACCEPT = "text/html,application/xhtml+xml,text/plain,application/json,application/pdf;q=0.9,*/*;q=0.5";
// Node's fetch refuses responses with more than 16 KB of headers (UND_ERR_HEADERS_OVERFLOW); some
// government portals (tamm.abudhabi: ~21 KB of cookies) exceed that. The fallback allows this much.
const BIG_HEADER_BYTES = 256 * 1024;
const MAX_REDIRECTS = 10;
const BATCH_PARALLEL = 4;
const tooBigDownload = (n) => `${fmt(n)} bytes or more — too big to read as a page`;
const article = (word) => (/^[aeiou]/i.test(word) ? "an" : "a");

/** Read a fetch body, stopping at the size cap. Returns null when the cap is exceeded. */
async function readCapped(body) {
	if (!body) return Buffer.alloc(0);
	const reader = body.getReader();
	const chunks = [];
	let n = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		n += value.byteLength;
		if (n > MAX_DOWNLOAD_BYTES) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

/** Plain node:http(s) download with a large header limit; used only when fetch hits the header cap. */
function downloadBigHeaders(url, signal, hops = 0) {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const mod = u.protocol === "http:" ? http : https;
		const req = mod.get(u, { headers: { "user-agent": USER_AGENT, accept: ACCEPT }, maxHeaderSize: BIG_HEADER_BYTES, signal }, (res) => {
			const status = res.statusCode ?? 0;
			if (status >= 300 && status < 400 && res.headers.location) {
				res.resume();
				if (hops >= MAX_REDIRECTS) return resolve({ problem: "too many redirects" });
				return downloadBigHeaders(new URL(res.headers.location, u).href, signal, hops + 1).then(resolve, reject);
			}
			if (status < 200 || status >= 300) {
				res.resume();
				return resolve({ problem: `the site answered HTTP ${status}` });
			}
			const type = String(res.headers["content-type"] ?? "").toLowerCase();
			const chunks = [];
			let n = 0;
			res.on("data", (c) => {
				n += c.length;
				if (n > MAX_DOWNLOAD_BYTES) {
					resolve({ problem: tooBigDownload(MAX_DOWNLOAD_BYTES) });
					req.destroy();
				} else chunks.push(c);
			});
			res.on("end", () => resolve({ type, buf: Buffer.concat(chunks) }));
			res.on("error", reject);
		});
		req.on("error", reject);
	});
}

/** Download one address. Returns { type, buf } or { problem } — never throws for a dead page. */
async function download(url, settings, signal) {
	const timeout = AbortSignal.timeout(settings.fetchTimeoutMs);
	const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const failure = (e, what = "could not be loaded") => {
		if (signal?.aborted) throw err(KIND.cancelled, "the call was cancelled.");
		if (timeout.aborted) return { problem: `no response within ${settings.fetchTimeoutMs / 1000} seconds` };
		return { problem: `${what} (${e?.cause?.code ?? e?.code ?? e?.message ?? e})` };
	};
	let res;
	try {
		res = await fetch(url, { redirect: "follow", signal: both, headers: { "user-agent": USER_AGENT, accept: ACCEPT } });
	} catch (e) {
		if ((e?.cause?.code ?? e?.code) === "UND_ERR_HEADERS_OVERFLOW" && !both.aborted) {
			try {
				return await downloadBigHeaders(url, both);
			} catch (e2) {
				return failure(e2);
			}
		}
		return failure(e);
	}
	if (!res.ok) {
		res.body?.cancel().catch(() => {});
		return { problem: `the site answered HTTP ${res.status}` };
	}
	const type = (res.headers.get("content-type") ?? "").toLowerCase();
	const len = Number(res.headers.get("content-length") ?? 0);
	if (len > MAX_DOWNLOAD_BYTES) {
		res.body?.cancel().catch(() => {});
		return { problem: tooBigDownload(len) };
	}
	try {
		const buf = await readCapped(res.body);
		return buf ? { type, buf } : { problem: tooBigDownload(MAX_DOWNLOAD_BYTES) };
	} catch (e) {
		return failure(e, "download broke off");
	}
}

// ---------- PDFs -> text (needs the free `pdftotext` program from poppler) ----------

let pdftotextPath; // cached once found; looked up again while missing
async function findPdftotext() {
	if (pdftotextPath) return pdftotextPath;
	const exe = process.platform === "win32" ? "pdftotext.exe" : "pdftotext";
	// GUI apps on macOS start with a short PATH, so also try the usual Homebrew/MacPorts places.
	const dirs = [...(process.env.PATH ?? "").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"];
	for (const d of dirs.filter(Boolean)) {
		const p = path.join(d, exe);
		try {
			await access(p, fsConstants.X_OK);
			return (pdftotextPath = p);
		} catch {
			/* try the next one */
		}
	}
	return undefined;
}
export const pdfSupport = () => Boolean(pdftotextPath);

const isPdf = (type, buf) => /application\/(x-)?pdf/.test(type ?? "") || buf?.subarray(0, 5).toString("latin1") === "%PDF-";

/** PDF bytes -> { text } or { problem }. */
async function pdfToText(buf, signal) {
	const tool = await findPdftotext();
	if (!tool) return { problem: "this is a PDF, and the `pdftotext` program (poppler) that squeeze uses to read PDFs is not installed — convert the PDF to text another way, then squeeze the text file" };
	const dir = await mkdtemp(path.join(tmpdir(), "dsh-squeeze-"));
	try {
		const file = path.join(dir, "in.pdf");
		await writeFile(file, buf);
		const text = await new Promise((resolve, reject) => {
			execFile(tool, ["-layout", "-enc", "UTF-8", file, "-"], { maxBuffer: 128 * 1024 * 1024, timeout: 120_000, signal, encoding: "utf8" }, (e, out, stderr) => (e ? reject(Object.assign(e, { stderr })) : resolve(out)));
		});
		const clean = text.replace(/\f/g, "\n\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
		if (clean.replace(/\s+/g, "").length < 50) return { problem: "this PDF has no text layer (probably a scan or photo) — it needs OCR, not squeeze" };
		return { text: clean };
	} catch (e) {
		if (signal?.aborted) throw err(KIND.cancelled, "the call was cancelled.");
		const why = String(e?.stderr || e?.message || e).trim();
		if (/password|encrypt/i.test(why)) return { problem: "the PDF is password-protected" };
		return { problem: `the PDF could not be converted to text (${why.slice(0, 200)})` };
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

/** Fetch one page and turn it into text. Returns { text } or { problem } — never throws for a dead page. */
async function fetchPage(url, settings, signal) {
	const d = await download(url, settings, signal);
	if (d.problem) return d;
	if (isPdf(d.type, d.buf)) return pdfToText(d.buf, signal);
	const kind = d.type.split(";")[0].trim();
	if (/image\/|audio\/|video\/|zip|octet-stream|msword|officedocument|ms-excel|opendocument/.test(kind)) {
		return { problem: `this is ${article(kind)} ${kind} file, not a web page — download it, convert it to text, then squeeze the text file` };
	}
	const raw = decodeBody(d.buf, d.type);
	const text = d.type.includes("html") || looksLikeHtml(raw) ? htmlToText(raw) : raw.trim();
	return { text };
}

/** Run fn over items with at most `limit` at once; results keep the input order. */
async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

async function readTextFile(ctx, exec, file) {
	let f = file.trim();
	if (f === "~" || f.startsWith("~/") || f.startsWith("~\\")) f = path.join(homedir(), f.slice(1));
	let cwd = process.cwd();
	try {
		cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
	} catch {
		/* keep process cwd */
	}
	const full = path.resolve(cwd, f);
	let info;
	try {
		info = await stat(full);
	} catch {
		throw err(KIND.source, `file not found: ${full}. Check the path (absolute, ~/..., or relative to the working directory).`);
	}
	if (!info.isFile()) throw err(KIND.source, `not a file: ${full}. squeeze reads one file per call, not folders.`);
	if (info.size === 0) throw err(KIND.source, `the file is empty: ${full}.`);
	if (info.size > MAX_DOWNLOAD_BYTES * 2) throw err(KIND.tooBig, `the file is ${fmt(info.size)} bytes — far over any model's limit. Split it into parts and squeeze each part.`);
	const buf = await readFile(full);
	if (isPdf("", buf)) {
		const pdf = await pdfToText(buf, exec.signal);
		if (pdf.problem) throw err(KIND.source, `${path.basename(full)}: ${pdf.problem}.`);
		return { text: pdf.text, label: full };
	}
	if (buf.subarray(0, 8192).includes(0)) {
		throw err(KIND.source, `${path.basename(full)} is not a text file (Excel, Word, image or similar). Convert it to text first, then squeeze the text file. Scans need OCR.`);
	}
	const raw = buf.toString("utf8").replace(/^\uFEFF/, "");
	return { text: looksLikeHtml(raw) ? htmlToText(raw) : raw, label: full };
}

// ---------- the helper's task ----------

export function buildTask(material, question, settings, { multi, missing }) {
	const lines = [
		"You are a careful reader. Answer the QUESTION using ONLY the MATERIAL below.",
		"- Copy names, figures, dates and quotes exactly as written; never estimate or fill gaps.",
		'- If the material does not contain the answer, say exactly what is missing ("not found in the material").',
		multi ? "- The material has several pages; say which page (URL) each point comes from." : "- Mention the section or heading where you found each point when it helps.",
		`- Be concise. Hard limit: ${settings.maxAnswerChars} characters (about ${fmt(Math.floor(settings.maxAnswerChars / 6.5))} words); anything longer is cut off. If the full answer would not fit, give the most important part and say what was left out.`,
	];
	if (missing.length) lines.push(`- These pages could NOT be read and are NOT in the material; do not guess their content, say so if they matter: ${missing.map((m) => m.url).join(", ")}`);
	lines.push("", "MATERIAL:", material, "", `QUESTION: ${question}`);
	return lines.join("\n");
}

// ---------- one model call ----------

/** Failure codes (DSH LLM layer) that mean "this model is down or refused" — fallback may move on. */
const DOWN_CODES = new Set(["TRANSPORT", "SERVER", "TIMEOUT", "RATE_LIMIT", "QUOTA", "ACCOUNT_QUOTA", "INVALID_CREDENTIAL", "NO_ADAPTER", "UNKNOWN_PROVIDER", "EMPTY_RESPONSE"]);
const TOO_BIG_CODES = new Set(["CONTEXT_WINDOW_EXCEEDED"]);
const DOWN_TEXT = {
	TRANSPORT: "could not be reached (connection failed)",
	SERVER: "answered with a server error",
	TIMEOUT: "did not respond (connection timed out)",
	RATE_LIMIT: "is rate-limited right now",
	QUOTA: "has no quota or credit left",
	ACCOUNT_QUOTA: "has no account quota left",
	INVALID_CREDENTIAL: "rejected the login / API key",
	EMPTY_RESPONSE: "sent an empty response",
};

/** Outcome of one attempt: { ok, answer, complete, seconds, usage } or { ok:false, reason, why, detail }. */
async function callModel(ctx, slot, settings, facts, task, exec) {
	const timeout = AbortSignal.timeout(settings.callTimeoutMs);
	const signal = exec.signal ? AbortSignal.any([exec.signal, timeout]) : timeout;
	const route = { provider: slot.provider, model: slot.model, maxTokens: outputBudget(settings, facts), ...(slot.reasoningEffort ? { reasoningEffort: slot.reasoningEffort } : {}) };
	let call;
	try {
		call = await ctx.llm.prepareCall(route, signal, (controls) => controls);
	} catch (e) {
		if (exec.signal?.aborted) throw err(KIND.cancelled, "the call was cancelled.");
		const code = e?.code ?? e?.failure?.code;
		if (code === "UNSUPPORTED_REASONING_EFFORT") {
			return { ok: false, reason: "down", why: `does not accept the thinking level "${slot.reasoningEffort}" set for it (fix it in Plugins → squeeze → Configure)`, detail: e.message };
		}
		return { ok: false, reason: "down", why: `is not available in DSH (${e?.message ?? e})`, detail: code };
	}
	const message = { id: randomUUID(), role: "user", content: [{ type: "text", text: task }], source: { kind: "dsh-squeeze" } };
	const sessionId = exec.agent?.session?.id;
	const options = { ...call.config, messages: [message], purpose: "squeeze", signal, ...(sessionId ? { sessionId } : {}) };
	let answer = "";
	let finish;
	let usage;
	const t0 = Date.now();
	try {
		for await (const chunk of call.stream(options)) {
			if (chunk.type === "text-delta") answer += chunk.text;
			else if (chunk.type === "block-end" && chunk.block?.type === "text" && !answer) answer = chunk.block.text ?? "";
			else if (chunk.type === "usage") usage = chunk.usage;
			else if (chunk.type === "finish") finish = chunk.reason;
		}
	} catch (e) {
		finish = { kind: signal.aborted ? "aborted" : "error", failure: { code: e?.code ?? "UNKNOWN", message: e?.message ?? String(e) } };
	}
	const seconds = (Date.now() - t0) / 1000;
	if (exec.signal?.aborted) throw err(KIND.cancelled, "the call was cancelled.");
	if (timeout.aborted) {
		throw err(KIND.timeout, `${slot.nickname} took longer than ${Math.round(settings.callTimeoutMs / 1000)} seconds and was stopped (the time limit is set in Plugins → squeeze → Configure). Ask a narrower question, send less material, or pick a faster model.`);
	}
	if (finish?.kind === "error" || finish?.kind === "aborted") {
		const code = finish.failure?.code ?? "UNKNOWN";
		const detail = finish.failure?.message ?? finish.kind;
		if (TOO_BIG_CODES.has(code)) return { ok: false, reason: "tooBig", why: "said the material does not fit its context window", detail };
		if (DOWN_CODES.has(code) || finish.kind === "aborted") return { ok: false, reason: "down", why: DOWN_TEXT[code] ?? `failed (${code})`, detail };
		return { ok: false, reason: "failed", why: `failed (${code})`, detail };
	}
	return { ok: true, answer: answer.trim(), complete: finish?.kind !== "max-tokens", seconds, usage };
}

// ---------- the tool ----------

const tails = new Map(); // provider -> promise of the last queued call
/**
 * One model call at a time per provider (a home machine serves one request at a time); calls to
 * different providers do not wait for each other. Later calls wait in line.
 */
function queued(lane, signal, job) {
	const tail = tails.get(lane) ?? Promise.resolve();
	const run = tail.then(() => {
		if (signal?.aborted) throw err(KIND.cancelled, "the call was cancelled while waiting for an earlier squeeze call.");
		return job();
	});
	const settled = run.then(() => undefined, () => undefined);
	tails.set(lane, settled);
	settled.then(() => {
		if (tails.get(lane) === settled) tails.delete(lane);
	});
	return run;
}

/** Cut an over-long answer at a line (or word) boundary near the limit. */
export function cutAnswer(answer, max) {
	if (answer.length <= max) return { answer, cut: false };
	let at = answer.lastIndexOf("\n", max);
	if (at < max * 0.6) at = answer.lastIndexOf(" ", max);
	if (at < max * 0.6) at = max;
	return { answer: `${answer.slice(0, at).trimEnd()}\n[… cut here: the answer was ${fmt(answer.length)} characters, over the ${fmt(max)}-character limit]`, cut: true };
}

function parseArgs(args, settings, slots) {
	args = { ...(args ?? {}) };
	if (args.file === undefined) {
		for (const alias of FILE_ALIASES) {
			if (typeof args[alias] === "string") {
				args.file = args[alias];
				break;
			}
		}
	}
	const ignored = Object.keys(args).filter((k) => IGNORED_ARGS.includes(k));
	const unknown = Object.keys(args).filter((k) => !KNOWN_ARGS.includes(k) && !IGNORED_ARGS.includes(k));
	if (unknown.length) throw err(KIND.request, `unknown parameter(s): ${unknown.join(", ")}. squeeze takes: prompt, url, urls, file${slots.length > 1 ? ", model" : ""}.`);
	const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
	if (!prompt) throw err(KIND.request, "a prompt is required: the question or instruction about the material.");
	const urls = [];
	if (args.url !== undefined) urls.push(args.url);
	if (args.urls !== undefined) {
		if (!Array.isArray(args.urls)) throw err(KIND.request, "`urls` must be a list of web addresses.");
		urls.push(...args.urls);
	}
	const hasFile = typeof args.file === "string" && args.file.trim() !== "";
	if (urls.length && hasFile) throw err(KIND.request, "give either web address(es) or a file, not both — make two calls.");
	if (!urls.length && !hasFile) throw err(KIND.request, "a source is required: `url`, `urls` or `file`.");
	if (urls.length > settings.maxUrls) throw err(KIND.request, `too many web addresses (${urls.length}); the limit is ${settings.maxUrls} per call. Split them into several calls.`);
	for (const u of urls) {
		if (typeof u !== "string" || !/^https?:\/\/\S+$/i.test(u.trim())) throw err(KIND.request, `not a valid web address (must start with http:// or https://): ${String(u).slice(0, 120)}`);
	}
	let start = 0;
	if (args.model !== undefined && args.model !== null && args.model !== "") {
		const wanted = String(args.model).trim().toLowerCase();
		start = slots.findIndex((s) => s.nickname === wanted);
		if (start < 0) throw err(KIND.request, `there is no squeeze model called "${args.model}". Choose one of: ${slots.map((s) => s.nickname).join(", ")} — or leave \`model\` out for the default.`);
	}
	return { prompt, urls: urls.map((u) => u.trim()), file: hasFile ? args.file : undefined, start, ignored };
}

async function gatherMaterial(ctx, exec, settings, a) {
	if (a.file) {
		const { text, label } = await readTextFile(ctx, exec, a.file);
		return { material: text, missing: [], shortReturn: undefined, sourceLabel: label };
	}
	if (a.urls.length === 1) {
		const url = a.urls[0];
		const page = await fetchPage(url, settings, exec.signal);
		if (page.problem) throw err(KIND.source, `${url}: ${page.problem}. Try web_fetch or a browser for this page.`);
		if (page.text.length < settings.minPageChars) {
			if (settings.shortPages === "return" && page.text.length > 0) return { material: page.text, missing: [], shortReturn: url };
			throw err(KIND.source, page.text.length === 0
				? `${url}: the page has no readable text (likely it needs JavaScript or blocks robots). Try web_fetch or a browser instead.`
				: `${url}: only ${page.text.length} characters of text came back (under the ${settings.minPageChars}-character minimum) — likely a JavaScript-only or blocked page. Try web_fetch or a browser instead.`);
		}
		return { material: page.text, missing: [] };
	}
	const parts = [];
	const missing = [];
	const pages = await mapLimit(a.urls, BATCH_PARALLEL, (url) => fetchPage(url, settings, exec.signal));
	for (const [i, url] of a.urls.entries()) {
		const page = pages[i];
		if (page.problem) missing.push({ url, why: page.problem });
		else if (page.text.length < settings.minPageChars) missing.push({ url, why: `only ${page.text.length} characters of text (JavaScript-only or blocked page?)` });
		else parts.push(`===== PAGE: ${url} =====\n${page.text}`);
	}
	if (!parts.length) {
		throw err(KIND.source, `none of the ${a.urls.length} pages could be read: ${missing.map((m) => `${m.url} (${m.why})`).join("; ")}. Nothing was sent to a model. Try web_fetch or a browser.`);
	}
	return { material: parts.join("\n\n"), missing };
}

function attemptOrder(slots, start, fallback) {
	const first = slots[start];
	if (!fallback) return [first];
	return [first, ...slots.filter((_s, i) => i !== start)];
}

export async function runSqueeze(ctx, config, args, exec) {
	const settings = readSettings(config);
	const slots = effectiveSlots(ctx, settings);
	if (!slots.length) throw err(KIND.modelDown, "no helper model is set up. Ask the user to choose one in Plugins → squeeze → Configure.");
	const a = parseArgs(args, settings, slots);
	const src = await gatherMaterial(ctx, exec, settings, a);

	if (src.shortReturn) {
		return {
			answer: src.material,
			status: `squeeze: SHORT PAGE RETURNED AS-IS — only ${src.material.length} characters of text came back, so no model was asked. This is probably a JavaScript-only, blocked or near-empty page: check whether the text above is real content; if not, use web_fetch or a browser.`,
		};
	}

	{
		const order = attemptOrder(slots, a.start, settings.fallback && slots.length > 1);
		const tokens = estimateTokens(src.material);
		const trail = [];
		const task = buildTask(src.material, a.prompt, settings, { multi: a.urls.length > 1, missing: src.missing });
		let lastFailure;
		for (const slot of order) {
			let facts = modelFacts.get(key(slot));
			if (!facts || facts.missing) {
				facts = await loadFacts(ctx, slot, exec.signal);
				modelFacts.set(key(slot), facts);
			}
			if (facts.missing) {
				lastFailure = { slot, reason: "down", why: `is not available in DSH (${facts.missing})` };
				trail.push(`${slot.nickname} ${lastFailure.why}`);
				continue;
			}
			const budget = materialTokenBudget(settings, facts);
			if (budget !== undefined && tokens > budget) {
				lastFailure = { slot, reason: "tooBig", why: `is too small for this material (~${fmt(tokens)} tokens; its limit is ~${fmt(budget)} tokens ≈ ${roughChars(budget)} characters)` };
				trail.push(`${slot.nickname} ${lastFailure.why}`);
				continue;
			}
			const r = await queued(slot.provider, exec.signal, () => callModel(ctx, slot, settings, facts, task, exec));
			if (!r.ok) {
				lastFailure = { slot, ...r };
				trail.push(`${slot.nickname} ${r.why}`);
				if (r.reason === "failed") break; // unexpected failure: do not walk the list blindly
				continue;
			}
			if (!r.answer) {
				throw err(KIND.noAnswer, `${slot.nickname} returned no answer${r.complete ? "" : " — its thinking used up the whole output budget"}. Ask a narrower question or send less material${r.complete ? "" : "; or raise the output budget in Plugins → squeeze → Configure"}.`);
			}
			let { answer, cut } = cutAnswer(r.answer, settings.maxAnswerChars);
			if (src.missing.length) {
				answer = `[${src.missing.length} of ${a.urls.length} pages could not be read and were left out — the answer uses only the other ${a.urls.length - src.missing.length}:]\n${src.missing.map((m) => `  - ${m.url} — ${m.why}`).join("\n")}\n\n${answer}`;
			}
			const bits = [
				!r.complete
					? "squeeze: ANSWER INCOMPLETE (the model ran out of output budget mid-answer — ask a narrower question or send less material)"
					: cut
						? `squeeze: ANSWER CUT (longer than the ${fmt(settings.maxAnswerChars)}-character answer limit — ask for fewer items, or split the question into several calls)`
						: "squeeze: ok",
				`model ${slot.nickname} (${facts.name ?? slot.model})`,
				`${r.seconds.toFixed(1)}s`,
				`source ${fmt(src.material.length)} chars`,
			];
			if (slot.reasoningEffort) bits.push(`thinking ${slot.reasoningEffort}`);
			let status = bits.join(" | ");
			if (trail.length) status += `\nFALLBACK: ${trail.join("; ")} — so ${slot.nickname} answered instead.`;
			if (a.ignored.length) status += `\nNote: ${a.ignored.join(", ")} ignored — the thinking level is fixed per model in the squeeze setup.`;
			return { answer, status };
		}
		// Every attempt failed.
		const tried = trail.join("; ");
		const single = order.length === 1;
		const fallbackHint = !settings.fallback && slots.length > 1 ? ` Fallback is off; you may retry with another model (${slots.filter((s) => s !== order[0]).map((s) => s.nickname).join(", ")}).` : "";
		if (lastFailure?.reason === "tooBig") {
			throw err(KIND.tooBig, `the material (${fmt(src.material.length)} characters, ~${fmt(tokens)} tokens) is too big: ${tried}. Nothing was cut. Split it (fewer pages, or part of the file) and ask again.${fallbackHint}`);
		}
		if (lastFailure?.reason === "failed") {
			throw err(KIND.noAnswer, `${tried}${lastFailure.detail ? ` — ${String(lastFailure.detail).slice(0, 300)}` : ""}. Try again once; if it repeats, tell the user.`);
		}
		const detail = lastFailure?.detail ? ` (details: ${String(lastFailure.detail).slice(0, 300)})` : "";
		throw err(KIND.modelDown, `${single ? "the model" : "no model could answer"}: ${tried}${detail}. Tell the user the squeeze model${single ? " is" : "s are"} unavailable; do not send the material to another service on your own.${fallbackHint}`);
	}
}

export function apply(ctx, config) {
	const factsOf = (slot) => modelFacts.get(key(slot));
	let lastShape = "";
	let refreshing;
	const current = () => {
		const settings = readSettings(config);
		const slots = effectiveSlots(ctx, settings);
		const shape = JSON.stringify(slots.map((s) => [s.provider, s.model]));
		if (shape !== lastShape && !refreshing) {
			lastShape = shape;
			refreshing = refreshFacts(ctx, slots).finally(() => {
				refreshing = undefined;
			});
		}
		return { settings, slots };
	};
	current();
	findPdftotext().catch(() => {}); // so the description can say whether PDFs are read
	ctx.effect(() => {
		const off = ctx.on?.("llm/adapters-updated", () => {
			modelFacts.clear();
			lastShape = "";
			current();
		});
		return () => off?.();
	}, "dsh-squeeze: model list changes");

	const definition = {
		name: "squeeze",
		output: {
			schema: { type: "object", additionalProperties: false, properties: { answer: { type: "string" }, status: { type: "string" } }, required: ["answer", "status"] },
			render: (_args, value) => [{ type: "text", text: `${value.answer}\n\n${value.status}` }],
		},
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			try {
				return await runSqueeze(ctx, config, args, exec);
			} catch (e) {
				if (e instanceof SqueezeError) throw e;
				throw new Error(`squeeze failed unexpectedly: ${e?.message ?? e}. Try again once; if it repeats, tell the user.`);
			}
		},
	};
	Object.defineProperty(definition, "description", {
		enumerable: true,
		get: () => {
			const { settings, slots } = current();
			return buildDescription(settings, slots, factsOf);
		},
	});
	Object.defineProperty(definition, "parameters", {
		enumerable: true,
		get: () => {
			const { settings, slots } = current();
			const properties = {
				prompt: { type: "string", description: "The question or instruction. Be specific (what, which section, which figures)." },
				url: { type: "string", description: "One web address (http/https)." },
				urls: { type: "array", items: { type: "string" }, description: `Several web addresses, read together (max ${settings.maxUrls}).` },
				file: { type: "string", description: pdfSupport() ? "Path to one text file (txt, md, csv, json, html, log, code) or text PDF. Not Word, Excel, scans or images." : "Path to one text file (txt, md, csv, json, html, log, code). Not PDF, Word, Excel or images." },
			};
			if (slots.length > 1) properties.model = { type: "string", enum: slots.map((s) => s.nickname), description: `Helper model nickname; omit for the default (${slots[0].nickname}).` };
			return { type: "object", properties, required: ["prompt"] };
		},
	});
	Object.defineProperty(definition, "timeoutMs", {
		enumerable: true,
		get: () => {
			const { settings, slots } = current();
			const attempts = settings.fallback ? Math.max(1, slots.length) : 1;
			// Waiting in line behind one earlier call, plus every attempt, plus page downloads.
			return (attempts + 1) * settings.callTimeoutMs + settings.maxUrls * settings.fetchTimeoutMs + 60_000;
		},
	});
	ctx.tools.register(definition);
}
