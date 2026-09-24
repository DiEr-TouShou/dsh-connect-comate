# Third-Party Notices

`dsh-connect-comate` is an independent implementation for WPS Comate. It borrows
design and code structure from the two MIT-licensed projects below, and their
license texts are reproduced here as those licenses require.

---

## dingminhua/dsh-connect-workbuddy

<https://github.com/dingminhua/dsh-connect-workbuddy>

Used for: the DSH bundle/plugin skeleton, the loopback-shim security model, the
pi-ai provider assembly, the credential-discovery and `doctor` diagnostics
structure, the plugin-card shell and `dsm-*` presentation language, and the
findings that make the DSH 0.1.7 line work at all (the settings service change,
the volatile-field requirement, live-reference config values, the client service
and slot changes) as documented in its 2.0.12–2.0.14 entries.

```text
MIT License

Copyright (c) 2026 LaoDing

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## corrinehu/dsh-workbuddy-connect

<https://github.com/corrinehu/dsh-workbuddy-connect>

The original working approach that `dsh-connect-workbuddy` transcribes and
verifies: the inbound hardening set (loopback Host check, loopback Origin check,
JSON content type on chat POSTs, constant-time bearer comparison), random-port
binding, request-body ceiling, upstream-error-to-HTTP-status mapping, and the
pi-ai provider assembly shape.

```text
MIT License

Copyright (c) 2026 Corrine Hu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## What is independent here

The WPS/Comate-specific work is original to this project and was established by
local measurement, not copied:

- the `~/.wpscomate/config.json` (`providers.official`) shape and the
  `agent/models.json` / `agent/auth/user_auth.json` candidate set;
- the `comate.wps.cn/llmproxy/v1/user/chat/completions` wire quirks (forced
  streaming, string `tool_choice`, `X-Comate-*` headers) and its error taxonomy;
- the model-directory projection (`llm-multimodal` → image input) and the
  `WPS Comate` provider descriptor;
- the read-only `GET /plugins/dsh-connect-comate/__catalog` status route and its
  `providerRegistered` diagnostic;
- the dual-line settings assembly in `src/settings-surface.ts` and the
  read-back-verified settings write in `src/client/settings-scope.ts`;
- the connection card's own form (wps_sid field, cookie-only toggle, model
  selection) and its zh/en copy.

## Upstream protocol references

The upstream request shape was also informed by
[Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) (MIT).
No code from that project is included.
