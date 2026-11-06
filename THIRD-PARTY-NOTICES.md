# Third-party notices

## HunYiSage/dsh-purge (MIT)

`vendor/dsh-purge/` contains `lib/` from dsh-purge v1.1.92, used to run that project's own patch table
against this tree. `prompts/anchor-plugin.md` is its `ANCHOR_TEXT` verbatim; `prompts/anchor.md` is that
text plus additions made here.

Upstream: https://github.com/HunYiSage/dsh-purge
Licensed under the MIT License; the upstream LICENSE and NOTICE are kept alongside the vendored code in
`vendor/dsh-purge/`.

## DeepSeek Harness

This repository patches a locally installed copy of DeepSeek Harness for local evaluation. It ships no
DeepSeek code. `build.ps1` reads the user's own installation.