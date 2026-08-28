# Icons

The status line uses one SVG per supported CLI. `harness.ts` imports the files
as text so they work without an asset server. Each SVG uses
`fill="currentColor"`.

| File | Source |
| --- | --- |
| `codex.svg` | OpenAI mark from Iconify's `logos` collection, CC0-1.0 |
| `claude.svg` | Claude mark from Simple Icons, CC0-1.0 |
| `opencode.svg` | opencode mark from Simple Icons, CC0-1.0 |
| `pi.svg` | Local pi glyph because the project publishes no mark |

The imported marks identify their CLIs and do not imply endorsement.

Interface controls use inline Lucide paths in `index.html`. Keep their 24-unit
view box and 2-pixel stroke so `.icon-btn svg` can style them as one set.
