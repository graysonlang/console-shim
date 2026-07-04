import test from "node:test";
import assert from "node:assert/strict";
import addConsoleSink from "../console.mjs";

// Logged before the first sink is registered: must be buffered and flushed.
console.log("early %s", "bird");

const captured = [];
addConsoleSink((level, message) => captured.push({ level, message }));

// Formats via the patched console and returns the message the sink received.
function fmt(...args) {
  captured.length = 0;
  console.log(...args);
  return captured[0]?.message;
}

test("buffers messages logged before the first sink is registered", () => {
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], { level: "log", message: "early bird" });
});

// --- Substitution basics -----------------------------------------------------

test("%s and %d substitution", () => {
  assert.equal(fmt("%s is %d years old.", "Bob", 42), "Bob is 42 years old.");
});

test("extra arguments are appended space-separated", () => {
  assert.equal(fmt("foo", "bar", 3), "foo bar 3");
});

test("unmatched specifiers are left verbatim", () => {
  assert.equal(fmt("count: %d"), "count: %d");
});

test("%c styling is consumed and ignored", () => {
  assert.equal(fmt("%cstyled", "color: red"), "styled");
});

// --- Integer precision/width -------------------------------------------------

test("%d truncates toward zero", () => {
  assert.equal(fmt("%d", 1234.56789), "1234");
  assert.equal(fmt("%d", -1234.56789), "-1234");
});

test("%d handles values beyond 32 bits", () => {
  // `x | 0` style coercion would wrap this to a negative number.
  assert.equal(fmt("%d", 3000000000), "3000000000");
});

test("%d of non-numeric input is NaN", () => {
  assert.equal(fmt("%d", "abc"), "NaN");
  assert.equal(fmt("%d", undefined), "NaN");
});

test("%d of Infinity", () => {
  assert.equal(fmt("%d", Infinity), "Infinity");
  assert.equal(fmt("%d", -Infinity), "-Infinity");
});

test("integer width pads with spaces", () => {
  assert.equal(fmt("%10i", 123), "       123");
});

test("integer precision zero-pads", () => {
  assert.equal(fmt("%.5d", 123), "00123");
});

test("negative zero-padded integers keep the sign in front", () => {
  assert.equal(fmt("%.4d", -5), "-0005");
});

// --- Float precision/width ---------------------------------------------------

test("%f without precision uses toString", () => {
  assert.equal(fmt("%f", 1234.56789), "1234.56789");
});

test("%.2f gives two digits after the decimal point for |x| >= 1", () => {
  assert.equal(fmt("%.2f", 1234.56789), "1234.57");
  assert.equal(fmt("%.2f", -1234.56789), "-1234.57");
  assert.equal(fmt("%.2f", 0), "0.00");
});

test("%.2f behaves like significant figures below 1 (documented quirk)", () => {
  // Implemented via toPrecision, so sub-1 values keep significant digits
  // rather than being rounded to "0.00".
  assert.equal(fmt("%.2f", 0.001234), "0.00123");
});

test("float width pads the formatted value", () => {
  assert.equal(fmt("%20.2f", 1234.56789), "1234.57".padStart(20, " "));
  assert.equal(fmt("%10f", -1234.56789), "-1234.56789"); // wider than field: no padding
});

test("%f of NaN and Infinity", () => {
  assert.equal(fmt("%.2f", NaN), "NaN");
  assert.equal(fmt("%.2f", Infinity), "Infinity");
});

// --- Crash guards ------------------------------------------------------------
// Real browsers ignore width/precision entirely; since this shim honors them,
// hostile or typo'd values must be clamped rather than throwing or hanging.

test("large float precision is clamped instead of throwing RangeError", () => {
  // toPrecision throws for arguments outside [1, 100].
  assert.equal(fmt("%.500f", 1.5), (1.5).toPrecision(100));
});

test("precision 0 does not reach toPrecision(0)", () => {
  // toPrecision(0) throws RangeError.
  assert.equal(fmt("%.0f", 1.5), "1.5");
});

test("huge field widths are clamped instead of exhausting memory", () => {
  const message = fmt("%1000000000d", 5);
  assert.equal(message.length, 200);
  assert.equal(message.trimStart(), "5");
});

test("huge zero-padding is clamped", () => {
  assert.equal(fmt("%.1000000d", 5), "5".padStart(100, "0"));
});

test("%s coerces exotic values without throwing", () => {
  assert.equal(fmt("%s", null), "null");
  assert.equal(fmt("%s", undefined), "undefined");
  assert.equal(fmt("%s", Symbol("tag")), "Symbol(tag)");
  // String(Object.create(null)) throws TypeError: falls back to the object formatter.
  assert.equal(fmt("%s", Object.create(null)), "{}");
});

test("logging a symbol as a plain argument does not throw", () => {
  // "" + Symbol() throws TypeError.
  assert.equal(fmt("value:", Symbol("tag")), "value: Symbol(tag)");
});

test("throwing getters cannot crash the logger", () => {
  const o = { good: 1, get bad() { throw new Error("boom"); } };
  assert.equal(fmt("%o", o), "{good: 1, bad: [Exception]}");
});

test("huge arrays are truncated instead of building a giant string", () => {
  const message = fmt("%o", new Array(500).fill(7));
  assert.ok(message.startsWith("Array(500) [7, 7,"));
  assert.ok(message.endsWith("… 400 more]"));
});

// --- Object formatting -------------------------------------------------------

test("%o formats objects", () => {
  assert.equal(fmt("%o", { a: 1, b: "x" }), '{a: 1, b: "x"}');
});

test("cycles collapse to a placeholder", () => {
  const a = { name: "a" };
  const b = { name: "b", other: a };
  a.other = b;
  assert.equal(fmt("%o", a), '{name: "a", other: {name: "b", other: {...}}}');
});

test("shared (non-cyclic) references are printed in full", () => {
  const shared = { x: 1 };
  assert.equal(fmt("%o", { a: shared, b: shared }), "{a: {x: 1}, b: {x: 1}}");
});

test("depth is limited", () => {
  assert.equal(fmt("%o", { a: { b: { c: { d: { e: 1 } } } } }), "{a: {b: {c: {d: {...}}}}}");
});

test("very sparse arrays print indices and values", () => {
  const a = [];
  a[10] = "x";
  a.length = 50;
  assert.equal(fmt("%o", a), 'Array(50) [10: "x"]');
});

test("mildly sparse arrays print gaps as empty", () => {
  assert.equal(fmt("%o", [1, , 3]), "Array(3) [1, empty, 3]");
});

// --- Levels, assert, sinks ---------------------------------------------------

test("levels are reported", () => {
  captured.length = 0;
  console.warn("careful");
  console.error("bad");
  console.info("fyi");
  console.debug("dbg");
  assert.deepEqual(captured.map((c) => c.level), ["warn", "error", "info", "debug"]);
});

test("console.assert emits only on failure", () => {
  captured.length = 0;
  console.assert(true, "unseen");
  console.assert(false, "code %d", 7);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], { level: "error", message: "Assertion failed: code 7" });
});

test("unsubscribing stops delivery", () => {
  const local = [];
  const unsubscribe = addConsoleSink((level, message) => local.push(message));
  console.log("one");
  unsubscribe();
  console.log("two");
  assert.deepEqual(local, ["one"]);
});

test("a sink that logs does not recurse infinitely", () => {
  const local = [];
  const unsubscribe = addConsoleSink((level, message) => {
    local.push(message);
    console.log("from sink"); // must not re-enter the sink
  });
  console.log("outer");
  unsubscribe();
  assert.deepEqual(local, ["outer"]);
});

test("a throwing sink does not break other sinks or the caller", () => {
  const local = [];
  const unsubBad = addConsoleSink(() => { throw new Error("bad sink"); });
  const unsubGood = addConsoleSink((level, message) => local.push(message));
  assert.doesNotThrow(() => console.log("still works"));
  assert.deepEqual(local, ["still works"]);
  unsubBad();
  unsubGood();
});
