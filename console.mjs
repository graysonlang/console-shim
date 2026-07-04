// console-shim: tees browser console output to pluggable sinks.
//
// Importing this module patches console.assert/debug/error/info/log/warn so
// that each call is formatted to a plain string and delivered to registered
// sinks, while still forwarding to the original console. Uncaught errors and
// unhandled promise rejections are captured and delivered as "error" messages.
//
// Messages logged before the first sink is registered are buffered (up to
// MAX_BUFFERED_MESSAGES) and flushed to that first sink.

const MAX_BUFFERED_MESSAGES = 1000;
// Formatting a message must never be able to throw or hang the page:
const MAX_FIELD_WIDTH = 200; // Cap "%200d"-style field widths; padStart(1e9) would exhaust memory.
const MAX_ZERO_PAD = 100;    // Cap "%.100d"-style zero padding.
const MAX_ITEMS = 100;       // Cap elements/keys printed per object or array.

const _sinks = [];
let _buffer = [];

function numDigits(x) {
  return String(Math.trunc(Math.abs(x))).length;
}

function formatFloat(f, precision, width = 0) {
  f = parseFloat(f);
  // Clamp the toPrecision argument to its legal range [1, 100]; values outside throw RangeError.
  return (precision ? f.toPrecision(Math.min(100, precision + numDigits(f))) : f.toString()).padStart(Math.min(width || 0, MAX_FIELD_WIDTH), " ");
}

function formatInt(i, precision = 0, width = 0) {
  const n = Math.trunc(parseFloat(i));
  let s;
  if (Number.isNaN(n)) {
    s = "NaN";
  } else {
    s = (n < 0 ? "-" : "") + Math.abs(n).toString().padStart(Math.min(precision || 0, MAX_ZERO_PAD), "0");
  }
  return s.padStart(Math.min(width || 0, MAX_FIELD_WIDTH), " ");
}

function safeString(param) {
  try {
    return String(param);
  } catch (e) {
    // String() throws for objects with no primitive conversion (e.g. Object.create(null)).
    return formatObject(param);
  }
}

function formatObject(o) {
  const seen = [];
  function helper(o, depth) {
    if (o && typeof o === "object") {
      // Insert a placeholder at the depth limit or when a cycle is encountered.
      if (depth > 3 || seen.includes(o)) {
        return Array.isArray(o) ? "[...]" : "{...}";
      }
      seen.push(o);
      const result = Array.isArray(o) ? formatArray(o, depth) : formatPlainObject(o, depth);
      seen.pop();
      return result;
    }
    if (typeof o === "string" || o instanceof String) {
      return `"${o}"`;
    }
    return String(o);
  }
  function formatProperty(o, k, depth) {
    // Property access can run arbitrary getters, which can throw.
    try {
      return helper(o[k], depth + 1);
    } catch (e) {
      return "[Exception]";
    }
  }
  function formatArray(o, depth) {
    const length = o.length;
    let count = 0;
    o.forEach(() => ++count);
    // Very sparse array (empty slots outnumber values): print only indices and values.
    if (count < length && (length - count) > count) {
      const keys = Object.keys(o);
      const shown = Math.min(keys.length, MAX_ITEMS);
      const contents = [];
      for (let i = 0; i < shown; ++i) {
        contents.push(`${keys[i]}: ${formatProperty(o, keys[i], depth)}`);
      }
      if (keys.length > shown) contents.push(`… ${keys.length - shown} more`);
      return `Array(${length}) [${contents.join(", ")}]`;
    }
    // Dense or mildly sparse array: print all the values with potential gaps.
    const shown = Math.min(length, MAX_ITEMS);
    const contents = [];
    for (let i = 0; i < shown; ++i) {
      contents.push(Object.hasOwn(o, i) ? formatProperty(o, i, depth) : "empty");
    }
    if (length > shown) contents.push(`… ${length - shown} more`);
    return `Array(${length}) [${contents.join(", ")}]`;
  }
  function formatPlainObject(o, depth) {
    const keys = Object.getOwnPropertyNames(o);
    const shown = Math.min(keys.length, MAX_ITEMS);
    const contents = [];
    for (let i = 0; i < shown; ++i) {
      contents.push(`${keys[i]}: ${formatProperty(o, keys[i], depth)}`);
    }
    if (keys.length > shown) contents.push(`… ${keys.length - shown} more`);
    return `{${contents.join(", ")}}`;
  }
  return helper(o, 0);
}

function gatherSubstitutions(s) {
  const regex = /%(\d*)\.?(\d*)([cdfiOos])/g;
  const result = [];
  let match;
  while ((match = regex.exec(s))) {
    result.push(match);
  }
  return result;
}

function formatForLogging(first, ...rest) {
  const output = [];
  if (typeof first === "string") {
    const matches = gatherSubstitutions(first);
    let position = 0;
    for (const match of matches) {
      if (rest.length < 1) {
        break;
      }
      output.push(first.substring(position, match.index));
      position = match.index + match[0].length;
      const kind = match[3];
      const param = rest.shift();
      switch (kind) {
        case "c":
        // Ignore CSS styling of output.
        break;
        // Integer
        case "d":
        case "i":
        output.push(formatInt(param, parseInt(match[2]), parseInt(match[1])));
        break;
        // Float
        case "f":
        output.push(formatFloat(param, parseInt(match[2]), parseInt(match[1])));
        break;
        // Object
        case "O":
        case "o":
        output.push(formatObject(param));
        break;
        // String
        case "s":
        output.push(safeString(param));
        break;
      }
    }
    // Append remaining portion of format string.
    output.push(first.substring(position, first.length));
  } else {
    // First argument is not a string, add it to the front of the array to be processed.
    rest.unshift(first);
  }
  // Handle remaining params (also is fallthrough case for first argument not being a String).
  while (rest.length) {
    const param = rest.shift();
    if (typeof param === "object") {
      output.push((output.length > 0 ? " " : "") + formatObject(param));
    } else {
      // safeString rather than concatenation: "" + Symbol() throws TypeError.
      output.push((output.length > 0 ? " " : "") + safeString(param));
    }
  }
  return output.join("");
}

// Store the built-in console methods so we can replace them while still
// forwarding to the originals.
const _console = globalThis.console;
const _original = {
  assert: _console.assert.bind(_console),
  debug: _console.debug.bind(_console),
  error: _console.error.bind(_console),
  info: _console.info.bind(_console),
  log: _console.log.bind(_console),
  warn: _console.warn.bind(_console),
};

// Suppresses emit() while re-entering the console: some console implementations
// delegate between methods internally (e.g. Node's assert calls warn), which
// would double-emit, and a sink that itself logs would recurse forever.
let _suppressEmit = false;

function deliver(sink, level, message) {
  try {
    sink(level, message);
  } catch (e) {
    // Report via the original console so a broken sink can't recurse into the shim.
    _original.error("console-shim: sink threw", e);
  }
}

function emit(level, message) {
  if (_suppressEmit) return;
  if (_sinks.length === 0) {
    if (_buffer.length < MAX_BUFFERED_MESSAGES) _buffer.push([level, message]);
    return;
  }
  _suppressEmit = true;
  try {
    for (const sink of _sinks) {
      deliver(sink, level, message);
    }
  } finally {
    _suppressEmit = false;
  }
}

function callOriginal(fn, args) {
  const previous = _suppressEmit;
  _suppressEmit = true;
  try {
    fn(...args);
  } finally {
    _suppressEmit = previous;
  }
}

// Replace the built-in console methods.
_console.assert = function(assertion, ...rest) {
  if (arguments.length && !assertion) emit("error", `Assertion failed: ${(rest.length ? formatForLogging(...rest) : "console.assert")}`);
  callOriginal(_original.assert, arguments);
};
for (const level of ["debug", "error", "info", "log", "warn"]) {
  _console[level] = function(...args) {
    if (args.length) emit(level, formatForLogging(...args));
    callOriginal(_original[level], args);
  };
}

// Route uncaught errors and unhandled promise rejections to sinks.
// (globalThis works in both window and worker contexts.)
if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("error", (event) => {
    const location = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
    const stack = event.error && event.error.stack;
    emit("error", `${event.message}${location}${stack ? `\n${stack}` : ""}`);
  });
  globalThis.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const detail = reason && reason.stack ? reason.stack : formatForLogging(reason);
    emit("error", `Unhandled promise rejection: ${detail}`);
  });
}

// Register a sink to receive (level, message) pairs. Returns an unsubscribe
// function. Messages buffered before the first sink was registered are
// flushed to that sink.
export function addConsoleSink(sink) {
  if (typeof sink !== "function") throw new TypeError("sink must be a function");
  _sinks.push(sink);
  if (_buffer.length) {
    const pending = _buffer;
    _buffer = [];
    _suppressEmit = true;
    try {
      for (const [level, message] of pending) {
        deliver(sink, level, message);
      }
    } finally {
      _suppressEmit = false;
    }
  }
  return () => removeConsoleSink(sink);
}

export function removeConsoleSink(sink) {
  const index = _sinks.indexOf(sink);
  if (index !== -1) _sinks.splice(index, 1);
}

export default addConsoleSink;
