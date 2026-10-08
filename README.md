# shitproxy

A dedicated TypeScript gateway for Claude clients using a router that serves both Anthropic Messages and OpenAI Responses.

- `POST /v1/messages`, model starts with **`anthropic/`**: send the original JSON bytes to upstream `/v1/messages`. Native tools, thinking, signatures, beta headers, errors, and SSE stay on the Anthropic path.
- The web client's exact bare IDs `claude-haiku-4-5-20251001` and `claude-sonnet-5-5` are prefixed with `anthropic/` and routed to native Messages. Their JSON bodies are reserialized for this rewrite; other fields are retained.
- Every other model: translate Messages to upstream `/v1/responses`, then translate JSON or streaming SSE back to Messages. **Preserve the model ID exactly.** Other bare `claude-*` IDs are not rewritten.
- A model id ending in **`:nothink`** (for example `deepseek/deepseek-flash:nothink`) has the suffix stripped before routing and thinking fully disabled for that request: `thinking` is forced to `disabled` and any `output_config.effort` is removed. This applies on both the native and translated paths, after suffix stripping but before the bare-ID rewrite above.
- `GET /v1/models`: proxy the upstream model listing, including query parameters.
- `GET /healthz`: local process liveness, without making a model request.

There is no provider guessing, model database, chat-completions fallback, shared conversation cache, or automatic retry that could execute a tool twice.

## Run with Docker

Copy `.env.example` to `.env`, fill in your router URL and keys, then:

```sh
docker compose up --build -d
docker compose logs -f gateway
```

The published port is bound to localhost. The container requires `GATEWAY_API_KEY` because it listens on all container interfaces. Use a TLS reverse proxy for remote access; the gateway does not terminate TLS itself.

Configure your Claude-compatible client with base URL **`http://127.0.0.1:4000`** and the gateway key. The client appends `/v1/messages`. Its model IDs must match your upstream router. This is the gateway component; it does not install or reconfigure Claude Desktop/Claudesk itself.

`UPSTREAM_URL` can include `/v1` or a router path such as `/router/v1`. If `/v1` is absent it is appended. Use one router that exposes both upstream protocols.

## Run locally

Node 22 or newer:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

PowerShell:

```powershell
$env:UPSTREAM_URL = 'https://your-router.example/v1'
$env:UPSTREAM_API_KEY = 'your-upstream-key'
$env:GATEWAY_API_KEY = 'your-gateway-key'
npm start
```

Shell:

```sh
UPSTREAM_URL=https://your-router.example/v1 \
UPSTREAM_API_KEY=your-upstream-key \
GATEWAY_API_KEY=your-gateway-key npm start
```

The default host is `127.0.0.1`, port `4000`. `npm run dev` runs the TypeScript source. Node does not automatically read `.env`; Compose does. To load `.env` locally, use `node --env-file=.env dist/main.js` after building.

## Reasoning preservation

Responses reasoning summaries become Anthropic `thinking` blocks. Reasoning items with no visible summary/content become `redacted_thinking` blocks. If a compatible router exposes plaintext `reasoning_text`, it is preserved too. OpenAI normally exposes summaries and opaque encrypted state, not the hidden reasoning tokens.

Each thinking signature or redacted block contains a versioned `spx:reasoning:v1:` envelope with the **whole reasoning item**, including its ID, summary, optional plaintext content, encrypted content, and status. The next request reconstructs that item before the associated tool calls and results. Multiple reasoning items remain distinct; state is carried in history instead of stored in server memory, so concurrent subagents and gateway restarts do not share or lose state. Clients must retain these blocks and signatures in subsequent history.

The envelope is base64url transport encoding. It does not encrypt plaintext summaries, decrypt encrypted content, authenticate the client, or imitate an Anthropic signature. Treat history and its opaque state as sensitive. The gateway does not log payloads or credentials. Foreign Anthropic signatures cannot be translated to OpenAI state and are rejected on the Responses path; they pass through on the native path. Changing visible text while retaining its envelope is rejected. Unsigned plaintext thinking can be replayed as a summary, but it contains no hidden state to recover.

Translated requests use `store: false` and request `reasoning.encrypted_content` for compatibility with older Responses routers. When `thinking` or reasoning effort is requested, the gateway requests `summary: auto`. These features still depend on the selected upstream model/provider supporting Responses reasoning.

Assistant message phases (`commentary`, `final_answer`, or null) are also preserved. Messages carrying a phase include a `spx:message:v1:` redacted metadata envelope after their visible text. Replaying that envelope restores the original assistant message, including its ID, phase, status, and content. Text changes with stale metadata are rejected. Clients must retain these metadata blocks as well as reasoning blocks.

## Translation support and boundaries

| Feature                              | Responses path                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| System/developer/user/assistant text | Supported, preserving message/block order                                                                           |
| URL and base64 images                | User input and tool results; no image downloads by the gateway                                                      |
| Client tool calls and results        | Supported, including parallel Task/subagent calls and nested JSON                                                   |
| Tool choice                          | auto, any/required, none, named function, parallel disabling                                                        |
| Tool errors                          | Explicit `[tool_error]` marker in tool result content                                                               |
| Summary and encrypted reasoning      | Lossless item replay through versioned envelopes                                                                    |
| Plaintext reasoning                  | Optional upstream `reasoning_text` preserved                                                                        |
| JSON schema output                   | Mapped to Responses structured output; upstream validates schema support                                            |
| Thinking budget                      | Approximate effort mapping: below 2048 low, below 8192 medium, otherwise high                                       |
| Adaptive thinking                    | medium effort by default                                                                                            |
| Explicit effort                      | low/medium/high unchanged; Anthropic max maps to Responses xhigh                                                    |
| Cache-control hints                  | Accepted but not mapped; upstream manages caching                                                                   |
| Usage                                | Cached input removed from Anthropic input_tokens and reported as cache_read_input_tokens                            |
| Streaming                            | UTF-8/CRLF framing, fragmented JSON arguments, ordered blocks, final signatures, usage, refusals, incomplete output |

For web-client compatibility, translated message history may include text-only `system` and `developer` roles. These retain their instruction roles and history positions. Other unsupported roles are reported by name without including message content.

Token-budget exception: Claude Desktop Code appends standalone system messages such as `<total_tokens>14998980 tokens left</total_tokens>` after tool calls. On the tested DeepSeek route, system messages are collected into the prompt prefix, so every added counter invalidates the conversation cache. On the translated Responses path, the proxy sends only these exact standalone counters as `user` messages at their original positions. This applies regardless of model name, including Desktop's opaque `claude-fable-subrouter-compat-v3-...` aliases: the provider cannot reliably be inferred from an alias. Model IDs are still forwarded exactly. These are informational counters, not instructions; using an ordinary content role prevents routers from hoisting them into the system prefix. A `developer` role is insufficient on routers that collect both instruction roles. General system instructions, environment messages, and native Anthropic requests are unchanged.

Session cache affinity: OpenCode and routers fronting it partition their prompt cache by an `x-opencode-session` request header, and a value that changes between requests of one conversation keys each request to a different cache bucket, so prefix reuse is lost and caching looks intermittent while every other provider stays warm. Claude Code never sends this header, so on the translated path the proxy fills it with a stable per-conversation value, taken in order from the `x-claude-code-session-id` header, the `_session_` segment of a composite `metadata.user_id` (Claude Code sends `user_<hex>_account_<uuid>_session_<uuid>`; the surrounding segments are per-device and deliberately unused), or a hash of the append-only conversation prefix (system, tools, first message) when the client sends no identity at all. The chosen value is SHA-256 hashed before it leaves the gateway, and it is only set when the caller supplied no `x-opencode-session` of its own, so no client identifier is forwarded verbatim and a caller's explicit value is preserved. A prefix-derived key changes exactly when the client rewrites history, such as after compaction. Native `anthropic/*` requests are untouched.

For temporary cache investigation, set `DEBUG_CACHE=1` on the proxy. It logs `cache_request` records with process-local keyed fingerprints of system blocks, tool definitions, translated input items, and request parameters, plus `cache_usage` records with upstream token counts. No prompt text, tool arguments, credentials, or signatures are logged. Match records by `trace_id`; compare requests with the same hashed `session` within one process lifetime. A null session means the client supplied no session identifier, so do not assume adjacent requests belong to the same conversation. Growing input counts are expected; changes to early item fingerprints or tool fingerprints identify candidate cache breaks. Raw cache-control changes can alter raw fingerprints without changing the translated prompt. Item details are capped at 512 entries; the aggregate fingerprint still covers the whole list. Fingerprints are not token counts or provider cache keys. Search continuations share the request trace ID, and their terminal usage is aggregated. Turn this flag off after diagnosis.

The protocols are not identical. `budget_tokens` cannot impose an exact Responses reasoning token budget. A provider can reject unsupported effort, sampling, structured output, image, or reasoning settings; the gateway preserves that failure instead of silently retrying with reduced capabilities.

On the translated path, unsupported blocks/tools/fields return an explicit 400: documents/PDFs, audio/video, native server tools other than basic web search (including computer use and dynamic-filtering search), native Anthropic citation tokens in translated history, context-management controls, top_k, nonempty stop_sequences, and assistant image history. Unknown upstream output/events and unsupported output annotations return 502 or an SSE error. Token counting, batches, and other endpoints are not implemented. Native `anthropic/*` messages bypass these translation restrictions.

Parallel upstream output items are buffered in output order to keep encrypted reasoning before tool calls. Out-of-order parts _inside one message/reasoning item_ fail explicitly. Truncated streams emit an Anthropic `error` event and do not emit `message_stop`. Terminal snapshots fill in missing deltas and routers that omit `output_item.done`; snapshots that contradict streamed content fail.

Translated streams also hold the opening answer after reasoning until it reaches 16 Unicode characters, generation ends, a tool/phase barrier appears, or 200 ms elapses. This repairs compatible routers that emit a tiny answer prefix before their final reasoning fragment: the late reasoning streams immediately, then the prefix and continuing answer form one text block. If the timer expires during an active reasoning block, release waits for that block to close so Anthropic blocks never overlap. After release, answer deltas stream normally; there is no whole-response wait. Reasoning arriving after release remains in its original order and may still display separately. Native Anthropic streams are unaffected. Reasoning envelopes retain each original item; a repaired answer's phase metadata retains its identity, phase and status with the joined visible answer text.

## Operational behavior

- Separate client and upstream credentials: `GATEWAY_API_KEY` checks ingress, `UPSTREAM_API_KEY` overrides upstream auth. Without a configured upstream key, caller auth is forwarded (for local pass-through setups). Always set both keys for the shared-key Compose deployment.
- Credential-bearing redirects are not automatically followed. Hop-by-hop headers, cookies, and client host/content-length are removed. Native response bodies are relayed as received by Fetch; decompression headers and stale lengths are removed if Fetch decoded the upstream content.
- `UPSTREAM_TIMEOUT_MS` defaults to 600000 for the entire generation. `MAX_BODY_BYTES` defaults to 32 MiB. Upstream JSON defaults to 32 MiB, SSE frames to 8 MiB, and total SSE event payloads to 128 MiB. Programmatic `createGateway` configuration can override all limits.
- Client disconnection aborts the upstream request. Writes honor downstream backpressure. Error messages never echo upstream response bodies or secrets.
- No automatic retries. Let the client make a deliberate retry; interruption may mean a tool call was already shown to the client.
- Graceful shutdown drains active connections for up to ten seconds.

## Verification

```sh
npm run test:coverage
```

Tests cover exact routing, native request bytes and SSE, tool/result ordering, parallel subagents, reasoning signatures and opaque ciphertext, a 100-turn tool loop, malformed inputs, HTTP failures, auth, deadlines, disconnects, slow readers, and SSE splits at every byte boundary. Seeded property tests run 1,400 additional generated examples for JSON arguments, reasoning envelopes, and Unicode/chunked streams.

Coverage thresholds are enforced in CI (90% lines/statements/functions; 85% branches). HTML coverage is written to `coverage/index.html`. CI checks Node 22 and 24 and builds the Docker image.

These are local tests against controlled upstreams, not evidence that your specific router and Claude UI work together. Before trusting it for real agent loops, run a text request, streaming request, image request, parallel tool call, and multi-turn reasoning/tool replay against your actual upstream. No live provider credentials are needed for the automated suite.

Protocol references: [Anthropic Messages](https://platform.claude.com/docs/en/api/http/messages), [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Responses reasoning](https://developers.openai.com/api/docs/guides/reasoning), [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events).

## Web search

Search routing applies only when the request declares Anthropic `web_search_20250305` with name `web_search`. An ordinary function named `web_search` remains a client tool and is never intercepted.

- `anthropic/*`: native Messages passthrough.
- `openai/*`: OpenAI Responses hosted `{ "type": "web_search" }`; the upstream must implement it.
- Other model IDs: a regular Responses function that shitproxy executes locally using Kagi, then feeds back as a function output. The client sees Anthropic server search calls/results rather than client tool requests.

Set `KAGI_SESSION` in the proxy environment for local search. `KAGI_TURNSTILE` optionally supplies the challenge cookie. Both are personal credentials: keep them in an untracked `.env`, never in requests or committed config. Compose passes these variables into the gateway; when using a separate Claudesk Compose service, add them to that service's environment too. The adapter copies the selectors from the user's `kagi-mcp` scraper; the original package is untouched. It uses Kagi's HTML search, not Kagi's separately billed Search API. Login/challenge pages and network failures become explicit unavailable search results, not invented search results.

Local searches return up to ten URLs, titles, snippets and available dates. Allowed/blocked domain restrictions are applied to the query and enforced on returned URLs. Results are snippets, not full-page extraction. Approximate `user_location` has no supported mapping in this adapter and is rejected explicitly. Later dynamic-filtering Anthropic search versions are also rejected.

Reasoning and answer text stream as they arrive. The proxy executes search calls and resumes the model within one Messages response, preserving prior reasoning and tool history. Search errors are supplied to the model without exception details. Ordinary client tool calls end the response normally so the client can execute them. Proxy metadata replays local searches as their original function calls/results; it contains no Kagi credentials. The local search tool instructs the model to cite sources using markdown links; native structured citation generation is not implemented for local search. Hosted OpenAI URL citations retain their Anthropic translation.

Local `max_uses` limits actual backend searches per Messages request (default five). At the limit, the function is removed from continuations; extra calls produce `max_uses_exceeded`. Continuations share the output-token budget and the request deadline, aggregate usage, and have a hard limit of sixteen model generations. Kagi searches have a twenty-second deadline and an eight-MiB HTML cap. There are no automatic retries or caches.

On the hosted OpenAI route, `max_uses` instead maps to Responses `max_tool_calls`. That counts all built-in tool actions and ignores excess calls, so it is not exactly Anthropic's search-only limit. Opaque source/citation tokens are locally encoded replay metadata, not provider-encrypted search content.
