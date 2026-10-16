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

## Additional local phone, light and reduced-motion evidence

Capture-only gate `beelink1-010e5b7961d29a881cb7e85239143dbc` exited 0 at
2026-10-16T01:58:09Z: 43 seconds overall, 18 seconds admission wait and
20 seconds command time. It guarded author
`4a613c6c67d3cdb43b13e1ffcf4dd83893751f9d` before/after and proved its only
difference from executable source `9645c98b` was this proof document.
The exact installed dependencies and built-file hashes matched the prior
`d3bda3` identity before and after; no installation or compilation was repeated.
The terminal watcher was armed within the same launch operation, 0.532 seconds
after launch. The host retained a cache-prune `Errno 11` / `cache=unpruned`
warning; that warning is separate from the browser command's exit 0.

| Actual CSS viewport | Actual theme | Actual reduced-motion preference | Public copy checks | Original uncut video |
| --- | --- | --- | --- | --- |
| 390 x 844 | light | false | 6/6 PASS | 5.08 seconds |
| 390 x 844 | light | true | 6/6 PASS, plus native denied-policy check | 5.44 seconds |
| 1440 x 900 | light | true | 6/6 PASS | 7.20 seconds |

Each case repeated native Tab/visible focus, Enter install copy, pointer env
copy, contextual success/ready feedback and local-state env recopy. Native
clipboard bytes matched 630 / 204 / 172 bytes respectively; focus remained on
the activated controls. Actual viewport meta, theme and media-query preference
matched the capture inputs. Document overflow, page errors and unexpected
console errors were all 0 in each case. Browser-received CSS matched the same
556723-byte production stylesheet hash above. All 22 viewport screenshots and
three original recordings were inspected with chronological one-second samples.
No full-page or tall-element screenshot resized the recording viewport.

The phone/light/reduced case used Chromium's actual permission policy to deny
`clipboard-write`. `navigator.permissions` reported `denied`, and the unchanged
native clipboard API threw `NotAllowedError`. Activating the real Copy install
control then displayed `Copy failed`, retained focus and left the clipboard at
its existing 22-byte baseline. This proves genuine denied-policy failure
feedback. The fallback did **not** copy under this policy; fallback success is
not claimed. No clipboard API or domain backend was mocked.

Phone/dark, the remaining viewport/theme/preference combinations, successful
clipboard fallback, other four contextual copy controls behind domain routes,
envelope/validator/chat states, theme switching and first paint remain unproved.
Root owns independent media review and completion of the remaining acceptance
conditions before merge. Deployment and served user-flow proof remain required
after merge; calibrated timing, latency, physical-device, full motion conformance
and production outcomes are UNKNOWN.

## Retained public artifacts

The [case and hash manifest](arena-shared-primitives-proof/010e5b/manifest.json)
retains all 22 original viewport PNGs, all three original uncut WebMs and the
three actual case observations. Each file has a byte count and SHA-256.

- [Phone/light/normal observations](arena-shared-primitives-proof/010e5b/phone-light-normal/observations.json)
- [Phone/light/reduced observations, including native permission denial](arena-shared-primitives-proof/010e5b/phone-light-reduced/observations.json)
- [Desktop/light/reduced observations](arena-shared-primitives-proof/010e5b/desktop-light-reduced/observations.json)

These are local built-app recordings with external domain traffic blocked,
not a served-production or full-design qualification. Earlier source and
failed-route recordings remain retained in the delivery evidence history.
