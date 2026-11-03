// Offline checks for dsh-squeeze with a fake DSH context (no real model calls).
// Run: ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --import ./test/hooks.mjs test/unit.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createVolatile } from "@deepseek-ai/cosmokit";
import * as plugin from "../index.js";

let passed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log("ok  ", name);
	} catch (e) {
		console.log("FAIL", name, "\n     ", e?.stack ?? e);
		process.exitCode = 1;
	}
}

// ---- fake model layer ----
const MODELS = {
	"local\0small": { name: "Small local", context: { contextWindow: 8000 }, defaultMaxTokens: 2000, reasoning: { efforts: [{ id: "off" }, { id: "low" }] } },
	"local\0big": { name: "Big local", context: { contextWindow: 262144 }, defaultMaxTokens: 24000, reasoning: { efforts: [{ id: "off" }, { id: "medium" }] } },
	"cloud\0huge": { name: "Huge cloud", context: { contextWindow: 1000000 }, defaultMaxTokens: 64000 },
};
let behaviour = {}; // "provider\0model" -> (options) => chunks[] | "hang"
const calls = [];

function fakeLlm() {
	return {
		listProviders: () => [{ id: "local", name: "Local" }, { id: "cloud", name: "Cloud" }],
		async resolveModelInfo(provider, model) {
			const m = MODELS[`${provider}\0${model}`];
			if (!m) throw new Error(`model "${model}" not found for provider "${provider}"`);
			return { provider, id: model, ...m };
		},
		async prepareCall(route, signal) {
			const k = `${route.provider}\0${route.model}`;
			if (!MODELS[k]) throw Object.assign(new Error(`unknown route ${k}`), { code: "NO_ADAPTER" });
			const efforts = MODELS[k].reasoning?.efforts.map((e) => e.id) ?? [];
			if (route.reasoningEffort && !efforts.includes(route.reasoningEffort)) throw Object.assign(new Error("bad effort"), { code: "UNSUPPORTED_REASONING_EFFORT" });
			return {
				config: { ...route },
				async *stream(options) {
					calls.push({ route, options });
					const b = behaviour[k] ?? (() => [{ type: "text-delta", text: `answer from ${route.model}` }, { type: "finish", reason: { kind: "stop" } }]);
					const out = b(options);
					if (out === "hang") {
						await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
						yield { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "aborted" } } };
						return;
					}
					if (out?.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
					for (const c of out.chunks ?? out) yield c;
					out.after?.();
				},
			};
		},
	};
}

function makeConfig(values) {
	const parsed = plugin.Config(values);
	return parsed;
}

function makeCtx(config, extra = {}) {
	let registered;
	const ctx = {
		llm: fakeLlm(),
		workingDirectory: { ensure: async () => process.cwd() },
		tools: { register: (d) => { registered = d; } },
		effect: () => {},
		on: () => () => {},
		get: (name) => extra[name],
	};
	plugin.apply(ctx, config);
	return { ctx, tool: () => registered };
}

const exec = () => ({ signal: new AbortController().signal, agent: undefined });
const three = [
	{ nickname: "quick", provider: "local", model: "small", reasoningEffort: "off", whenToUse: "short pages, lists" },
	{ nickname: "careful", provider: "local", model: "big", reasoningEffort: "medium", whenToUse: "contracts and numbers" },
	{ nickname: "cloud", provider: "cloud", model: "huge", whenToUse: "only when the user allows cloud" },
];

// ---- a tiny real PDF (one page of text) ----
function makePdf(text) {
	const stream = text.split("\n").map((line, i) => `BT /F1 10 Tf 40 ${760 - i * 14} Td (${line}) Tj ET`).join("\n");
	const objs = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offs = [];
	objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}
const PDF_TEXT = Array.from({ length: 8 }, (_, i) => `Line ${i}: The licence fee is AED 3220 and the permit is renewed every year in Dubai.`).join("\n");
const PDF = makePdf(PDF_TEXT);
const EMPTY_PDF = makePdf("");

// ---- local web server ----
const LONG = "<html><body><h1>Prices</h1><table><tr><th>Item</th><th>Price</th></tr><tr><td>Apple</td><td>2 AED</td></tr></table>" + "<p>filler text about fruit. </p>".repeat(40) + "</body></html>";
const server = createServer((req, res) => {
	if (req.url === "/long") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(LONG); }
	else if (req.url === "/short") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body>Please enable JavaScript.</body></html>"); }
	else if (req.url === "/pdf") { res.writeHead(200, { "content-type": "application/pdf" }); res.end(PDF); }
	else if (req.url === "/scan.pdf") { res.writeHead(200, { "content-type": "application/pdf" }); res.end(EMPTY_PDF); }
	else if (req.url === "/image") { res.writeHead(200, { "content-type": "image/png" }); res.end("x"); }
	else if (req.url === "/bigheaders") { res.writeHead(200, { "content-type": "text/html", "set-cookie": Array.from({ length: 30 }, (_, i) => `c${i}=${"x".repeat(900)}`) }); res.end(LONG); }
	else if (req.url === "/redirect-big") { res.writeHead(302, { location: "/bigheaders", "x-pad": "y".repeat(20000) }); res.end(); }
	else { res.writeHead(404); res.end("nope"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const dir = await mkdtemp(path.join(tmpdir(), "squeeze-test-"));
await writeFile(path.join(dir, "notes.txt"), "The meeting is on 14 November 2026 in room 4.\n".repeat(20));
await writeFile(path.join(dir, "bin.dat"), Buffer.from([0x50, 0x4b, 3, 4, 0, 1, 2, 3]));
await writeFile(path.join(dir, "doc.pdf"), PDF);
await writeFile(path.join(dir, "scan.pdf"), EMPTY_PDF);
const tick = () => new Promise((r) => setTimeout(r, 20));

// ---- tests ----
await test("schema: defaults and volatile refs", () => {
	const c = makeConfig({});
	assert.equal(c.contextFillPercent.get(), 80);
	assert.equal(c.fallback.get(), false);
	assert.deepEqual([...c.models.get()], []);
	assert.equal(c.shortPages.get(), "return");
});

await test("schema: rejects a bad nickname", () => {
	assert.throws(() => makeConfig({ models: [{ nickname: "Bad Name", provider: "a", model: "b" }] }));
});

await test("description lists nicknames, notes, limits and fallback mode", async () => {
	const { tool } = makeCtx(makeConfig({ models: three, fallback: true }));
	await tick();
	const d = tool().description;
	assert.match(d, /quick \(default\) — short pages, lists \[max ~\d/);
	assert.match(d, /careful — contracts and numbers \[max ~[\d,]+ characters per call\]/);
	assert.match(d, /Fallback is on/);
	assert.deepEqual(tool().parameters.properties.model.enum, ["quick", "careful", "cloud"]);
	assert.equal(tool().parameters.properties.effort, undefined);
});

await test("description follows a settings change without re-registering", async () => {
	const config = makeConfig({ models: three.slice(0, 1) });
	const { tool } = makeCtx(config);
	await tick();
	assert.equal(tool().parameters.properties.model, undefined);
	config.models[Symbol.for("cosmokit.volatile.write")](three);
	config.fallback[Symbol.for("cosmokit.volatile.write")](false);
	tool().description;
	await tick();
	assert.match(tool().description, /Fallback is off/);
	assert.ok(tool().parameters.properties.model);
});

await test("no models set up -> DSH default model is used", async () => {
	const { tool } = makeCtx(makeConfig({}), { agentDefaultModel: { currentSelection: () => ({ provider: "local", model: "big" }) } });
	await tick();
	assert.match(tool().description, /default \(the DSH default model, Big local\)/);
	const r = await tool().execute({ prompt: "q", file: path.join(dir, "notes.txt") }, exec());
	assert.match(r.answer, /answer from big/);
});

await test("picks the model by nickname and fixes its thinking level", async () => {
	calls.length = 0;
	const { tool } = makeCtx(makeConfig({ models: three }));
	const r = await tool().execute({ prompt: "when?", file: path.join(dir, "notes.txt"), model: "careful", effort: "high" }, exec());
	assert.match(r.status, /model careful \(Big local\)/);
	assert.equal(calls.at(-1).route.reasoningEffort, "medium");
	assert.match(r.status, /effort ignored/);
});

await test("file_path alias works; unknown key refused", async () => {
	const { tool } = makeCtx(makeConfig({ models: three }));
	const r = await tool().execute({ prompt: "q", file_path: path.join(dir, "notes.txt") }, exec());
	assert.match(r.status, /squeeze: ok/);
	await assert.rejects(tool().execute({ prompt: "q", file: path.join(dir, "notes.txt"), colour: 1 }, exec()), /REQUEST PROBLEM: unknown parameter\(s\): colour/);
});

await test("unknown nickname -> REQUEST PROBLEM listing the choices", async () => {
	const { tool } = makeCtx(makeConfig({ models: three }));
	await assert.rejects(tool().execute({ prompt: "q", file: path.join(dir, "notes.txt"), model: "turbo" }, exec()), /REQUEST PROBLEM: there is no squeeze model called "turbo"\. Choose one of: quick, careful, cloud/);
});

await test("fallback ON: unreachable model -> next model answers, status says so", async () => {
	behaviour["local\0small"] = () => [{ type: "finish", reason: { kind: "error", failure: { code: "TRANSPORT", message: "ECONNREFUSED 10.0.0.5:8080" } } }];
	const { tool } = makeCtx(makeConfig({ models: three, fallback: true }));
	const r = await tool().execute({ prompt: "q", file: path.join(dir, "notes.txt") }, exec());
	assert.match(r.answer, /answer from big/);
	assert.match(r.status, /FALLBACK: quick could not be reached \(connection failed\) — so careful answered instead/);
	delete behaviour["local\0small"];
});

await test("fallback OFF: unreachable model -> MODEL UNAVAILABLE with retry hint", async () => {
	behaviour["local\0small"] = () => [{ type: "finish", reason: { kind: "error", failure: { code: "SERVER", message: "502 Bad Gateway" } } }];
	const { tool } = makeCtx(makeConfig({ models: three, fallback: false }));
	await assert.rejects(tool().execute({ prompt: "q", file: path.join(dir, "notes.txt") }, exec()), (e) => {
		assert.match(e.message, /^squeeze MODEL UNAVAILABLE: the model: quick answered with a server error \(details: 502 Bad Gateway\)\. Tell the user/);
		assert.match(e.message, /Fallback is off; you may retry with another model \(careful, cloud\)/);
		return true;
	});
	delete behaviour["local\0small"];
});

await test("fallback ON: material too big for the small model -> skipped before calling it", async () => {
	calls.length = 0;
	const bigFile = path.join(dir, "big.txt");
	await writeFile(bigFile, "word ".repeat(10000));
	const { tool } = makeCtx(makeConfig({ models: three, fallback: true }));
	const r = await tool().execute({ prompt: "q", file: bigFile }, exec());
	assert.equal(calls.length, 1);
	assert.equal(calls[0].route.model, "big");
	assert.match(r.status, /FALLBACK: quick is too small for this material/);
});

await test("fallback OFF: too big -> TOO BIG with split advice", async () => {
	const { tool } = makeCtx(makeConfig({ models: three }));
	await assert.rejects(tool().execute({ prompt: "q", file: path.join(dir, "big.txt") }, exec()), /squeeze TOO BIG: the material \(50,000 characters.*Split it/);
});

await test("provider says context exceeded -> treated as too big, fallback moves on", async () => {
	behaviour["local\0big"] = () => [{ type: "finish", reason: { kind: "error", failure: { code: "CONTEXT_WINDOW_EXCEEDED", message: "prompt too long" } } }];
	const { tool } = makeCtx(makeConfig({ models: three, fallback: true }));
	const r = await tool().execute({ prompt: "q", file: path.join(dir, "big.txt"), model: "careful" }, exec());
	assert.match(r.answer, /answer from huge/);
	assert.match(r.status, /careful said the material does not fit/);
	delete behaviour["local\0big"];
});

await test("timeout -> TIMED OUT, no fallback", async () => {
	behaviour["local\0small"] = () => "hang";
	calls.length = 0;
	const { tool } = makeCtx(makeConfig({ models: three, fallback: true, callTimeoutSeconds: 30 }));
	// shrink the limit for the test by patching the volatile ref
	const cfg = makeConfig({ models: three, fallback: true, callTimeoutSeconds: 30 });
	cfg.callTimeoutSeconds[Symbol.for("cosmokit.volatile.write")](0.3);
	const t = makeCtx(cfg).tool();
	await assert.rejects(t.execute({ prompt: "q", file: path.join(dir, "notes.txt") }, exec()), /squeeze TIMED OUT: quick took longer than 0 seconds/);
	assert.equal(calls.length, 1);
	delete behaviour["local\0small"];
	void tool;
});

await test("thinking eats the budget -> NO ANSWER with budget hint", async () => {
	behaviour["local\0big"] = () => [{ type: "reasoning-delta", text: "hmm" }, { type: "finish", reason: { kind: "max-tokens" } }];
	const { tool } = makeCtx(makeConfig({ models: three }));
	await assert.rejects(tool().execute({ prompt: "q", file: path.join(dir, "notes.txt"), model: "careful" }, exec()), /NO ANSWER: careful returned no answer — its thinking used up the whole output budget/);
	delete behaviour["local\0big"];
});

await test("answer cut off -> ANSWER INCOMPLETE status, text kept", async () => {
	behaviour["local\0big"] = () => [{ type: "text-delta", text: "partial" }, { type: "finish", reason: { kind: "max-tokens" } }];
	const { tool } = makeCtx(makeConfig({ models: three }));
	const r = await tool().execute({ prompt: "q", file: path.join(dir, "notes.txt"), model: "careful" }, exec());
	assert.equal(r.answer, "partial");
	assert.match(r.status, /ANSWER INCOMPLETE/);
	delete behaviour["local\0big"];
});

await test("model removed from DSH -> MODEL UNAVAILABLE naming it", async () => {
	const { tool } = makeCtx(makeConfig({ models: [{ nickname: "gone", provider: "local", model: "deleted" }] }));
	await assert.rejects(tool().execute({ prompt: "q", file: path.join(dir, "notes.txt") }, exec()), /MODEL UNAVAILABLE: the model: gone is not available in DSH/);
});

await test("short page returned as-is (default) without a model call", async () => {
	calls.length = 0;
	const { tool } = makeCtx(makeConfig({ models: three }));
	const r = await tool().execute({ prompt: "q", url: `${base}/short` }, exec());
	assert.equal(r.answer, "Please enable JavaScript.");
	assert.match(r.status, /SHORT PAGE RETURNED AS-IS/);
	assert.equal(calls.length, 0);
});

await test("short page refused when set to refuse", async () => {
	const { tool } = makeCtx(makeConfig({ models: three, shortPages: "refuse" }));
	await assert.rejects(tool().execute({ prompt: "q", url: `${base}/short` }, exec()), /SOURCE PROBLEM: .*only 25 characters/);
});

await test("long page converted: table survives as | cells |", async () => {
	calls.length = 0;
	const { tool } = makeCtx(makeConfig({ models: three }));
	await tool().execute({ prompt: "price of apple?", url: `${base}/long` }, exec());
	const text = calls[0].options.messages[0].content[0].text;
	assert.match(text, /# Prices/);
	assert.match(text, /\| Apple \| 2 AED \|/);
});

await test("dead page / image link -> SOURCE PROBLEM with correct grammar", async () => {
	const { tool } = makeCtx(makeConfig({ models: three }));
	await assert.rejects(tool().execute({ prompt: "q", url: `${base}/missing` }, exec()), /SOURCE PROBLEM: .*HTTP 404/);
	await assert.rejects(tool().execute({ prompt: "q", url: `${base}/image` }, exec()), /SOURCE PROBLEM: .*this is an image\/png file/);
});

await test("PDF link is converted to text and sent to the model", async () => {
	calls.length = 0;
	const { tool } = makeCtx(makeConfig({ models: three }));
	const r = await tool().execute({ prompt: "fee?", url: `${base}/pdf` }, exec());
	assert.match(r.status, /squeeze: ok/);
	assert.match(calls[0].options.messages[0].content[0].text, /AED 3220/);
	assert.match(tool().description, /PDF links and PDF files are converted automatically/);
});

await test("PDF file is converted; scanned PDF -> OCR advice", async () => {
	calls.length = 0;
	const { tool } = makeCtx(makeConfig({ models: three }));
	await tool().execute({ prompt: "fee?", file: path.join(dir, "doc.pdf") }, exec());
	assert.match(calls[0].options.messages[0].content[0].text, /renewed every year/);
	await assert.rejects(tool().execute({ prompt: "q", file: path.join(dir, "scan.pdf") }, exec()), /SOURCE PROBLEM: scan\.pdf: this PDF has no text layer .*OCR/);
	await assert.rejects(tool().execute({ prompt: "q", url: `${base}/scan.pdf` }, exec()), /no text layer/);
});

await test("site with >16 KB of headers is still read (also after a redirect)", async () => {
	calls.length = 0;
	const { tool } = makeCtx(makeConfig({ models: three }));
	await tool().execute({ prompt: "price?", url: `${base}/bigheaders` }, exec());
	assert.match(calls[0].options.messages[0].content[0].text, /\| Apple \| 2 AED \|/);
	await tool().execute({ prompt: "price?", url: `${base}/redirect-big` }, exec());
	assert.match(calls[1].options.messages[0].content[0].text, /\| Apple \| 2 AED \|/);
});

await test("batch: dead pages skipped and listed; all dead -> one error", async () => {
	const { tool } = makeCtx(makeConfig({ models: three }));
	const r = await tool().execute({ prompt: "q", urls: [`${base}/long`, `${base}/missing`, `${base}/short`] }, exec());
	assert.match(r.answer, /^\[2 of 3 pages could not be read/);
	await assert.rejects(tool().execute({ prompt: "q", urls: [`${base}/missing`, `${base}/x`] }, exec()), /none of the 2 pages could be read/);
});

await test("binary file refused with conversion advice", async () => {
	const { tool } = makeCtx(makeConfig({ models: three }));
	await assert.rejects(tool().execute({ prompt: "q", file: path.join(dir, "bin.dat") }, exec()), /SOURCE PROBLEM: bin\.dat is not a text file/);
});

await test("one call at a time", async () => {
	let active = 0;
	let maxActive = 0;
	behaviour["local\0small"] = () => {
		active++;
		maxActive = Math.max(maxActive, active);
		return { delayMs: 80, after: () => active--, chunks: [{ type: "text-delta", text: "x" }, { type: "finish", reason: { kind: "stop" } }] };
	};
	const { tool } = makeCtx(makeConfig({ models: three }));
	const wrap = () => tool().execute({ prompt: "q", file: path.join(dir, "notes.txt") }, exec());
	await Promise.all([wrap(), wrap(), wrap()]);
	assert.equal(maxActive, 1);
	delete behaviour["local\0small"];
});

await test("over-long answer is cut at a line break and marked ANSWER CUT", async () => {
	const long = Array.from({ length: 200 }, (_, i) => `line ${i} with some words`).join("\n");
	behaviour["local\0big"] = () => [{ type: "text-delta", text: long }, { type: "finish", reason: { kind: "stop" } }];
	const { tool } = makeCtx(makeConfig({ models: three, maxAnswerChars: 1000 }));
	const r = await tool().execute({ prompt: "q", file: path.join(dir, "notes.txt"), model: "careful" }, exec());
	assert.match(r.status, /ANSWER CUT \(longer than the 1,000-character answer limit/);
	const kept = r.answer.split("\n[… cut here")[0];
	assert.ok(kept.length <= 1000 && /words$/.test(kept), kept.slice(-40));
	assert.match(r.answer, /cut here: the answer was [\d,]+ characters/);
	delete behaviour["local\0big"];
});

await test("different providers run side by side; same provider waits", async () => {
	let active = 0;
	let maxActive = 0;
	const slow = () => {
		active++;
		maxActive = Math.max(maxActive, active);
		return { delayMs: 80, after: () => active--, chunks: [{ type: "text-delta", text: "x" }, { type: "finish", reason: { kind: "stop" } }] };
	};
	behaviour["local\0big"] = slow;
	behaviour["cloud\0huge"] = slow;
	const { tool } = makeCtx(makeConfig({ models: three }));
	const f = path.join(dir, "notes.txt");
	await Promise.all([tool().execute({ prompt: "q", file: f, model: "careful" }, exec()), tool().execute({ prompt: "q", file: f, model: "cloud" }, exec())]);
	assert.equal(maxActive, 2);
	delete behaviour["local\0big"];
	delete behaviour["cloud\0huge"];
});

await test("batch keeps page order while downloading in parallel", async () => {
	calls.length = 0;
	const { tool } = makeCtx(makeConfig({ models: three }));
	await tool().execute({ prompt: "q", urls: [`${base}/long`, `${base}/pdf`, `${base}/bigheaders`] }, exec());
	const text = calls[0].options.messages[0].content[0].text;
	const order = [...text.matchAll(/===== PAGE: (\S+) =====/g)].map((m) => m[1].replace(base, ""));
	assert.deepEqual(order, ["/long", "/pdf", "/bigheaders"]);
});

await test("CJK text counts ~1 token per character", () => {
	assert.equal(plugin.estimateTokens("中文测试"), 4);
	assert.equal(plugin.estimateTokens("abcdefghij"), 4);
});

server.close();
console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
