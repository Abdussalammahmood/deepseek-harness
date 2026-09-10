# Toolbox: this deployment's MCP servers, tools, and skills

This branch adds one isolated feature to DeepSeek Harness: a **Toolbox** panel
that lists every MCP server, native tool provider, and installed skill, lets a
human switch them on and off, and warns — in a floating window — while a
capability that can control the computer is enabled.

It is written for two readers: the human who runs this deployment, and an AI
agent that has to understand the setup without being told.

## Where everything lives

| Piece | Location |
|---|---|
| MCP servers, tools, skills (the source of truth) | `D:\deepseekHarnes\mcp` — its own git repo, see below |
| Toolbox host plugin (settings namespace, applies switches) | `packages/experimental/toolbox` |
| Toolbox browser plugin (the tab and the warning overlay) | `packages/client/ui-toolbox` |
| Generated DSH profile patch (never edit by hand) | `%DSH_HOME%\profiles\web\cordis.patch.yml` |

The companion repository — installers, manifests, the `mcp.ps1` CLI, and the
full usage guide — is
**[Abdussalammahmood/dsh-mcp](https://github.com/Abdussalammahmood/dsh-mcp)**.
It links back to this branch, so either side can be the entry point.

## Install (fresh machine)

```sh
git clone https://github.com/Abdussalammahmood/dsh-mcp.git D:\deepseekHarnes\mcp
cd D:\deepseekHarnes\mcp
setup.cmd
```

`setup.cmd` installs `uv` if missing, installs every enabled MCP server at its
pinned version, refreshes tool lists, links the two Toolbox plugin packages into
the DSH profile, and regenerates the profile patch. It is idempotent.

## Use

- **GUI:** Settings → Plugins → **Toolbox**. One tab with three lists.
- **CLI:** `D:\deepseekHarnes\mcp\mcp.cmd` opens a menu; `mcp.ps1 help` lists
  commands (`list`, `status`, `on`, `off`, `hide`, `show`, `probe`, `patch`,
  `setup`).
- **Chat:** ``hello-toolbox`` is an example skill; ask for a "toolbox check".
- **Agent:** the model-facing ``toolbox`` tool runs the same operations -
  ``status``, ``setup``, ``server_enable``, ``server_disable``, ``tool_enable``,
  ``tool_disable``, ``provider_enable``, ``provider_disable``, ``skill_enable``,
  ``skill_disable`` - so an agent can install and switch this setup itself.

## What each switch actually does

| Switch | Mechanism |
|---|---|
| MCP server on/off | writes `enabled` in that server's manifest, then regenerates the profile patch |
| MCP tool on/off | writes the tool name into the server's exclusion environment variable (`env-exclude` filter style) |
| Native tool provider on/off | writes the loader entry id into `plugins.json`, which the patch generator turns into an id-targeted `disabled: true` row |
| Skill on/off | sets `disable-model-invocation` in that skill's own `SKILL.md` frontmatter, which the skill provider's watcher picks up with no patch involved |

Native tools are grouped by the plugin that contributes them, not listed
individually: `ctx.tools.restrict()` refuses to run outside an agent scope, so
no context-global per-tool gate exists to call. Bundled skills are read-only;
the panel says so rather than offering a switch that cannot work.

The profile composes with `patchReload: live`, so every switch above applies
without restarting the harness. A browser refresh is needed to pick up a
changed client bundle.

## Why it merges cleanly

All behaviour lives in the two new packages. The only edits outside them are
four lines: two tsconfig project references and two dependency lines in the
web-app bundle manifest. A later upstream pull conflicts with none of the
feature code; resolving means re-running `setup.cmd`.

## Example installs

Two opt-in examples exist so the plumbing can be checked end to end:

- **Skill:** `%DSH_HOME%\skills\hello-toolbox\SKILL.md` — appears in the skill
  catalog and in the Toolbox tab, and can be switched off there.
- **Tool:** the shipped `tool-cordis` example, enabled as a row in
  `mcp\plugins.json`. It adds dynamic-runtime tools, so treat it like shell
  access and switch it off when it is not needed.

## Safety posture

A panel that switches capabilities off is only useful if the dangerous ones are
visible and off by default. MCP servers that advertise machine-controlling tools
are labelled `controls PC`, and the overlay stays visible while any of them
is enabled. The overlay is a draggable HUD: it defaults to the top-right so it never
blocks the composer's send button, remembers where you drag it, and collapses to
a small pill.
is enabled, and the toolbox manager can disable any server from the command line
if the GUI is unavailable.
