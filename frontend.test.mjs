// Unit tests for the browser code (no browser needed):  node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import * as U from "../public/js/utils.js";
import { createStore, sanitizeExpense } from "../public/js/store.js";
import { guessCategory, parseExpensesLocally, localInsights } from "../public/js/fallback.js";
import { createAI, extractJSON, normalizeAIExpense, buildChatContext, summaryForAI, AIError } from "../public/js/ai.js";
import { doughnutSVG, barsSVG } from "../public/js/charts.js";

const TODAY = "2026-10-17";                                   // a Saturday
const E = (date, amount, category, description = "x") => ({ id: `${date}${amount}${category}`, date, amount, category, description });

test("date helpers", () => {
  assert.equal(U.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(U.addMonths("2026-01", -1), "2025-12");
  assert.deepEqual(U.lastNMonths("2026-02", 3), ["2025-12", "2026-01", "2026-02"]);
  assert.equal(U.daysInMonth("2028-02"), 29);
  assert.ok(U.isValidISO("2026-02-28") && !U.isValidISO("2026-02-30") && !U.isValidISO("26-1-1"));
  assert.equal(U.weekdayName(TODAY), "Saturday");
  assert.equal(U.formatMoney(1234.5, "Rs"), "Rs 1,234.5");
  assert.equal(U.formatMoney(10, "$"), "$10");
});

test("summarize: totals, categories, daily average, budget, previous month", () => {
  const data = [E("2026-10-01", 1000, "Food & Dining"), E("2026-10-10", 3000, "Rent"), E("2026-10-17", 500, "Food & Dining"),
                E("2026-09-20", 2000, "Rent"), E("2026-11-02", 99, "Other")];
  const s = U.summarize(data, "2026-10", { budget: 6000, today: TODAY });
  assert.equal(s.total, 4500);
  assert.equal(s.count, 3);
  assert.deepEqual(s.byCategory.map((c) => [c.name, c.value]), [["Rent", 3000], ["Food & Dining", 1500]]);
  assert.equal(Math.round(s.byCategory[0].percent), 67);
  assert.equal(s.daysElapsed, 17);
  assert.equal(Math.round(s.dailyAvg), Math.round(4500 / 17));
  assert.equal(s.todayTotal, 500);
  assert.equal(s.prevTotal, 2000);
  assert.equal(s.top[0].amount, 3000);
  assert.equal(Math.round(s.budget.used), 75);
  assert.equal(s.budget.remaining, 1500);
  assert.equal(s.budget.over, false);
  assert.equal(U.summarize(data, "2026-10", { budget: 4000, today: TODAY }).budget.over, true);
  assert.equal(U.summarize(data, "2026-09", { today: TODAY }).daysElapsed, 30);       // a finished month uses all its days
  assert.deepEqual(U.monthTotals(data, ["2026-09", "2026-10"]).map((m) => m.value), [2000, 4500]);
});

test("CSV export escapes quotes and blocks spreadsheet formulas", () => {
  const csv = U.toCSV([{ date: "2026-10-01", description: 'He said "hi", ok', category: "Other", amount: 5 },
                       { date: "2026-10-02", description: "=HYPERLINK(\"http://evil\")", category: "Other", amount: 6 }]);
  const lines = csv.split("\n");
  assert.equal(lines[0], "Date,Description,Category,Amount");
  assert.equal(lines[1], '2026-10-01,"He said ""hi"", ok",Other,5');
  assert.ok(lines[2].includes("'=HYPERLINK"));
});

test("escapeHtml", () => assert.equal(U.escapeHtml(`<img src=x onerror="a">&'`), "&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;"));

test("store: sanitises, saves, reloads and survives damaged data", () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  const store = createStore(storage);
  const a = store.add({ amount: "250.456", description: "  Lunch ", category: "Nonsense", date: "2026-10-05", source: "ai" });
  assert.deepEqual([a.amount, a.description, a.category, a.source], [250.46, "Lunch", "Other", "ai"]);
  assert.equal(store.add({ amount: -5, description: "bad", date: "2026-10-05" }), null);
  assert.equal(store.add({ amount: 5, description: "bad date", date: "2026-13-45" }), null);
  assert.equal(store.add({ amount: 5, description: "", date: "2026-10-05" }), null);
  store.add({ amount: 10, description: "Newer", category: "Transport", date: "2026-10-09" });
  assert.deepEqual(store.getExpenses().map((e) => e.description), ["Newer", "Lunch"]);       // newest first
  assert.equal(createStore(storage).getExpenses().length, 2);                                 // reload
  assert.equal(store.remove(a.id), true);
  assert.equal(store.getExpenses().length, 1);
  assert.deepEqual(store.saveSettings({ currency: " PKR12345 ", budget: "-3" }), { currency: "PKR1", budget: 0 });
  mem.set("smartspend.expenses.v1", "{not json");
  assert.deepEqual(createStore(storage).getExpenses(), []);
  mem.set("smartspend.expenses.v1", JSON.stringify([{ amount: 5, description: "ok", date: "2026-01-01" }, 7, null, { amount: "x" }]));
  assert.equal(createStore(storage).getExpenses().length, 1);
  const broken = createStore({ getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); } });
  assert.doesNotThrow(() => broken.add({ amount: 1, description: "still works", date: "2026-01-01" }));
});

test("offline category guessing", () => {
  const cases = { "KFC zinger burger": "Food & Dining", "Uber to university": "Transport", "electricity bill": "Bills & Utilities",
    "monthly rent": "Rent", "doctor visit": "Health", "tuition fee": "Education", "Netflix": "Entertainment", "vegetables and milk": "Groceries", "random thing": "Other" };
  for (const [text, expected] of Object.entries(cases)) assert.equal(guessCategory(text), expected, text);
});

test("offline parser: several items, k suffix, relative dates", () => {
  const r = parseExpensesLocally("lunch 450 and uber 300 yesterday", TODAY);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => [x.amount, x.category, x.date]), [[450, "Food & Dining", "2026-10-16"], [300, "Transport", "2026-10-16"]]);
  const k = parseExpensesLocally("Paid Rs 1.5k for internet bill last friday", TODAY)[0];
  assert.deepEqual([k.amount, k.category, k.date], [1500, "Bills & Utilities", "2026-10-16"]);
  assert.equal(parseExpensesLocally("last saturday rent 25,000", TODAY)[0].date, "2026-10-10");
  assert.equal(parseExpensesLocally("hello how are you", TODAY).length, 0);
  assert.equal(parseExpensesLocally("coffee 200, snacks 150, bus 80", TODAY).length, 3);
});

test("offline insights mention totals and budget", () => {
  const s = U.summarize([E("2026-10-01", 3000, "Rent"), E("2026-10-02", 1000, "Food & Dining"), E("2026-09-05", 2000, "Rent")], "2026-10", { budget: 3500, today: TODAY });
  const text = localInsights(s, "Rs").join(" ");
  assert.match(text, /Rs 4,000/);
  assert.match(text, /over your budget by Rs 500/);
  assert.match(text, /Rs 2,000 more/);
  assert.match(localInsights(U.summarize([], "2026-10", { today: TODAY }), "Rs")[0], /No expenses/);
});

test("extractJSON handles fences and extra words", () => {
  assert.deepEqual(extractJSON('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJSON('Sure! Here it is: {"a":[1,2]} Hope it helps'), { a: [1, 2] });
  assert.equal(extractJSON("no json"), null);
  assert.equal(extractJSON(null), null);
});

test("normalizeAIExpense repairs or rejects bad AI output", () => {
  assert.deepEqual(normalizeAIExpense({ amount: "Rs 1,200", description: "Pizza", category: "Food & Dining", date: "2026-10-15" }, TODAY),
    { amount: 1200, description: "Pizza", category: "Food & Dining", date: "2026-10-15" });
  const fixed = normalizeAIExpense({ amount: 50, description: "Uber ride", category: "Taxi stuff", date: "2030-01-01" }, TODAY);
  assert.deepEqual([fixed.category, fixed.date], ["Transport", TODAY]);         // unknown category guessed, future date replaced
  assert.equal(normalizeAIExpense({ amount: 0, description: "x" }, TODAY), null);
  assert.equal(normalizeAIExpense({ amount: "abc" }, TODAY), null);
  assert.equal(normalizeAIExpense("text", TODAY), null);
});

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    const h = handlers[method];
    if (!h) throw new Error("network down");
    const { status = 200, json } = typeof h === "function" ? h(body) : h;
    return { ok: status < 400, status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

test("AI client: offline when the backend says ai:false or is unreachable", async () => {
  for (const handlers of [{ GET: { json: { ok: true, ai: false } } }, {}, { GET: { status: 404, json: {} } }]) {
    const ai = createAI({ fetchImpl: fakeFetch(handlers) });
    assert.equal((await ai.checkBackend()).online, false);
    const r = await ai.parseExpenses("tea 100", TODAY);
    assert.deepEqual([r.usedAI, r.expenses.length, r.expenses[0].amount], [false, 1, 100]);
    assert.equal((await ai.suggestCategory("uber")).category, "Transport");
    await assert.rejects(() => ai.ask("q", "ctx"), AIError);
  }
});

test("AI client: online parsing sends JSON-mode request and validates the answer", async () => {
  const f = fakeFetch({
    GET: { json: { ok: true, ai: true, model: "llama-x" } },
    POST: (body) => ({ json: { content: JSON.stringify({ expenses: [
      { amount: 450, description: "Lunch", category: "Food & Dining", date: "2026-10-16" },
      { amount: -1, description: "bad" }, { amount: 300, description: "Uber", category: "???", date: "bad" }] }) } }),
  });
  const ai = createAI({ fetchImpl: f });
  const status = await ai.checkBackend();
  assert.deepEqual([status.online, status.model], [true, "llama-x"]);
  const r = await ai.parseExpenses("lunch 450 and uber 300", TODAY);
  assert.equal(r.usedAI, true);
  assert.deepEqual(r.expenses.map((e) => [e.amount, e.category, e.date]), [[450, "Food & Dining", "2026-10-16"], [300, "Transport", TODAY]]);
  const post = f.calls.find((c) => c.method === "POST").body;
  assert.equal(post.json, true);
  assert.equal(post.temperature, 0);
  assert.match(post.messages[0].content, /2026-10-17/);
  assert.match(post.messages[0].content, /Food & Dining, Groceries/);
});

test("AI client: if the AI call fails, the offline rules are used and a warning is returned", async () => {
  const ai = createAI({ fetchImpl: fakeFetch({ GET: { json: { ai: true } }, POST: { status: 429, json: { error: "AI rate limit reached." } } }) });
  await ai.checkBackend();
  const r = await ai.parseExpenses("tea 100", TODAY);
  assert.equal(r.usedAI, false);
  assert.equal(r.expenses[0].amount, 100);
  assert.match(r.warning, /rate limit/);
  const ins = await ai.insights(U.summarize([E("2026-10-01", 100, "Other")], "2026-10", { today: TODAY }), "Rs");
  assert.equal(ins.usedAI, false);
});

test("AI client: an answer that is not JSON falls back to the offline rules; an empty JSON list is trusted", async () => {
  let content = "Sorry, I cannot do that";
  const ai = createAI({ fetchImpl: fakeFetch({ GET: { json: { ai: true } }, POST: () => ({ json: { content } }) }) });
  await ai.checkBackend();
  const bad = await ai.parseExpenses("coffee 120", TODAY);
  assert.deepEqual([bad.usedAI, bad.expenses.length, bad.expenses[0].amount], [false, 1, 120]);
  assert.match(bad.warning, /could not be understood/);
  content = '{"expenses":[]}';
  const none = await ai.parseExpenses("hello there", TODAY);
  assert.deepEqual([none.usedAI, none.expenses.length], [true, 0]);
});

test("AI client: insights and chat use the data and keep history short", async () => {
  const f = fakeFetch({ GET: { json: { ai: true, model: "m" } }, POST: { json: { content: "- Food is your top area\n- Spend less on snacks\n" } } });
  const ai = createAI({ fetchImpl: f });
  await ai.checkBackend();
  const s = U.summarize([E("2026-10-01", 900, "Food & Dining", "Pizza")], "2026-10", { budget: 2000, today: TODAY });
  const ins = await ai.insights(s, "Rs");
  assert.deepEqual(ins.lines, ["Food is your top area", "Spend less on snacks"]);
  assert.equal(summaryForAI(s, "Rs").byCategory[0].amount, 900);
  const ctx = buildChatContext([E("2026-10-01", 900, "Food & Dining", "Pizza")], "2026-10", "Rs", 2000);
  assert.match(ctx, /2026-10-01 \| Food & Dining \| 900 \| Pizza/);
  const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
  await ai.ask("how much on food?", ctx, history);
  const sent = f.calls.filter((c) => c.method === "POST").at(-1).body.messages;
  assert.equal(sent.length, 1 + 4 + 1);                                         // system + last 4 history + question
  assert.match(sent[0].content, /Pizza/);
});

test("charts produce valid, escaped SVG", () => {
  const d = doughnutSVG([{ name: "<b>Food</b>", value: 1000, percent: 60, color: "#f00" }, { name: "Rent", value: 600, percent: 40, color: "#00f" }],
    { currency: "Rs", centerTop: "Rs 1,600", centerBottom: "total" });
  assert.match(d, /^<svg/);
  assert.ok(d.includes("&lt;b&gt;Food&lt;/b&gt;") && !d.includes("<b>Food"));
  assert.equal((d.match(/stroke-dasharray/g) || []).length, 2);
  const b = barsSVG([{ label: "Sep", value: 0 }, { label: "Oct", value: 12500, highlight: true }], { currency: "Rs" });
  assert.match(b, /bar bar-now/);
  assert.match(b, />13k<|>12k</);
});
