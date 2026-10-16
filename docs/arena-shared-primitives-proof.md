# Arena shared-primitives proof

PR: https://github.com/tangle-network/ai-trading-blueprint/pull/197

## Checked consumer and scope

The local production build at source `9645c98b64c0ea834e33f856121cd81860c2a251`
passed the public `/operators/register` copy flow on 2026-10-16 UTC.
This is local consumer evidence, not a deployment, performance, or complete design acceptance.

Installed owners were UI **11.37.0**, Brand **1.25.1**, Vite **7.3.5** and
React Router **8.3.0**. The app used Node **22.23.3**; the installed browser owner
used Node **24.18.0**, Playwright **1.63.0** and Chromium **153.0.8010.12**.
The CSS viewport was **1440 x 900**, the actual theme was **dark**, and the native
viewport meta was `width=device-width, initial-scale=1`.

## Observed results

| Interaction | Actual result |
| --- | --- |
| Public registration route | Registration form and both copy controls rendered |
| Native Tab to Copy install | Focus reached the control; `:focus-visible` and its outline were present |
| Enter on Copy install | Native clipboard exactly matched the rendered 630-byte command; `Command copied`; focus retained |
| Pointer on Copy .env | Native clipboard exactly matched the rendered 204-byte env block; `Env copied`; focus retained |
| Feedback completion | Both original ready labels returned |
| Select Public, then Copy .env | Local React state changed the rendered env block; native clipboard exactly matched its 172 bytes |

Clipboard checks compared actual `navigator.clipboard.readText()` against the
rendered code blocks. No clipboard API was replaced. No copied command ran.
The original uncut recording is 7.44 seconds; seven screenshots and eight
chronological video samples were inspected. Document horizontal overflow was
0 px, page errors were 0, and unexpected console errors were 0.

The browser received `root-BNTGKAMX.css`, 556723 bytes, SHA-256
`13490b4f4a1497d71f03032051f8a103c98027e5e84bc850ff4242960b3029f0`,
matching the freshly built CSS identity. The preview server logged readiness
without runtime errors. Build output retained chunk-size warnings and an
UnoCSS SSR `vite:css-post` plugin warning; those were not runtime proof failures.

## Gate and corrected cause

Gate `beelink1-d3bda32af0e1268cc498bf7cf1ee240c` exited 0 after 142 seconds,
following 159 seconds of normal admission wait. It refreshed `origin/main`,
typechecked and rebuilt the changed route, exercised the browser flow, then
pushed through normal hooks. Tracked-clean author guards before, after build,
before push and after all matched source `9645c98b`. The gate's fetched cache
SHA was the distinct earlier `35aec0a`; it is not the tested author identity.
Unchanged dependency installation proof comes from gate
`beelink1-ffd5e76f772d20938df09f96dba61931`.

Earlier gate `beelink1-c2c5b851e893f856a1944b4ccc04fdac` failed at the first
route assertion on `35aec0a`: the parent directory omitted its child outlet,
so no copy action occurred. Its original 13.52-second failure recording and
screenshot remain retained. The fix uses a stable outlet wrapper and renders
the existing directory as a separate component, preserving hook ordering.

## Limits and next checks

All external requests and domain operations were blocked, including RPC,
fonts and WebSockets. Expected blocked-resource console messages are retained
separately from unexpected errors. The local static app was not given a fake
backend. No wallet connected, account registered, command executed, endpoint
probed, or paid turn requested.

Phone/light/reduced-motion, clipboard denied/fallback, other four contextual
copy controls behind domain routes, envelope/validator/chat states, theme
switching and first paint remain unproved. Root owns independent media review
and completion of these acceptance conditions before merge. Deployment and
served user-flow proof remain required after merge; latency, physical-device
and production outcomes are UNKNOWN.
