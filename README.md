# @graysonlang/console-shim

Tee browser `console` output to anywhere — the Xcode console via WKWebView, a logging backend, or the page itself.

Importing the module patches `console.assert` / `debug` / `error` / `info` / `log` / `warn` so that every call is:

1. formatted to a **plain string** (printf-style substitutions, cycle-safe object dumps — exactly what `postMessage` payloads and log ingestion want), and
2. delivered to any number of registered **sinks**,

while still forwarding to the real console. Uncaught errors and unhandled promise rejections are captured and delivered as `"error"` messages. Zero dependencies.

## Usage

```js
import addConsoleSink from "@graysonlang/console-shim";

const unsubscribe = addConsoleSink((level, message) => {
  // level: "debug" | "error" | "info" | "log" | "warn"
  // message: the fully formatted string
});
```

Messages logged before the first sink is registered are buffered (up to 1000) and flushed to that first sink, so early startup logging isn't lost.

For script injection (no module loader), build the IIFE bundle with `npm run build` and use the global:

```js
ConsoleShim.addConsoleSink((level, message) => { /* ... */ });
```

## Recipe: WKWebView console → Xcode

WKWebView swallows `console.*` output unless Safari Web Inspector is attached — useless in CI, TestFlight, or for native developers living in Xcode. Inject the IIFE bundle plus a sink that posts to a script message handler:

```swift
import WebKit
import os

final class ConsoleMessageHandler: NSObject, WKScriptMessageHandler {
    private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "app", category: "webview")

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let level = body["level"] as? String,
              let text = body["message"] as? String else { return }
        switch level {
        case "error": log.error("\(text, privacy: .public)")
        case "warn":  log.warning("\(text, privacy: .public)")
        case "debug": log.debug("\(text, privacy: .public)")
        default:      log.info("\(text, privacy: .public)")
        }
    }
}

let controller = WKUserContentController()
controller.add(ConsoleMessageHandler(), name: "console")

let shim = try! String(contentsOf: Bundle.main.url(forResource: "console-shim.iife", withExtension: "js")!)
let sink = """
ConsoleShim.addConsoleSink((level, message) => {
  window.webkit.messageHandlers.console.postMessage({ level, message });
});
"""
controller.addUserScript(WKUserScript(source: shim + "\n" + sink,
                                      injectionTime: .atDocumentStart,
                                      forMainFrameOnly: false))

let config = WKWebViewConfiguration()
config.userContentController = controller
let webView = WKWebView(frame: .zero, configuration: config)
```

`.atDocumentStart` matters: the shim is installed before any page script runs, so parse-time errors and early logging are captured.

## Recipe: error capture to a backend

```js
import addConsoleSink from "@graysonlang/console-shim";

addConsoleSink((level, message) => {
  if (level !== "error") return;
  navigator.sendBeacon("/api/client-logs", JSON.stringify({
    level, message, url: location.href, ts: Date.now(),
  }));
});
```

Multiple sinks can coexist — tee to Xcode *and* a backend at once.

## API

| Export | Description |
| --- | --- |
| `addConsoleSink(sink)` (default export) | Register a `(level, message) => void` sink. Returns an unsubscribe function. |
| `removeConsoleSink(sink)` | Unregister a sink. |

A sink that throws is reported via the original `console.error` and never breaks other sinks or the logging call site.

## Formatting semantics

Supports `%s` `%d` `%i` `%f` `%o` `%O` `%c` with optional `width.precision` (e.g. `%10.2f`). Remaining arguments beyond the format string are appended space-separated; objects are dumped cycle-safe and depth-limited (4 levels, 100 elements/keys per object, sparse-array aware).

Note that browsers' own consoles **ignore** width and precision despite what some documentation claims — this shim honors them, with these semantics:

- `%d` / `%i` — truncates toward zero (correct beyond 2³¹). Precision zero-pads, width space-pads: `%.4d` of `-5` → `-0005`.
- `%f` — precision is digits after the decimal point for |x| ≥ 1. Implemented via `toPrecision`, so values below 1 keep significant figures instead of collapsing: `%.2f` of `0.001234` → `0.00123`, not `0.00`.
- `%o` / `%O` — formatted object dump.
- `%c` — the CSS argument is consumed and ignored.

### Crash guards

Formatting can never throw or hang the page, including the cases that break naive console shims:

- `toPrecision` arguments are clamped to the legal `[1, 100]` range (out-of-range throws `RangeError`; `%.0f` never reaches `toPrecision(0)`).
- Field widths are capped at 200 and zero-padding at 100 — `%1000000000d` would otherwise allocate a gigabyte-sized string via `padStart`.
- Throwing property getters render as `[Exception]`.
- `%s` of `Object.create(null)` (no `toString`) and bare `Symbol` arguments are stringified safely — both throw `TypeError` under naive coercion.
- Huge arrays/objects truncate with `… N more`; recursion is depth-limited and cycle-safe.

## Development

```sh
npm test       # formatter + sink tests (node --test, no dependencies)
npm run build  # dist/console-shim.iife.js for script injection
```

[index.html](index.html) is a visual test page — serve the directory and open it to see the DOM-sink demo.

## License

Public domain (Unlicense). See [LICENSE](LICENSE).
