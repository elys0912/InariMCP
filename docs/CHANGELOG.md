# Changelog

**English** | [日本語](./CHANGELOG.ja.md)

User-facing changes of Inari MCP for Firefox, newest first.

Inari MCP for Firefox started on 2026-10-14 as a copy of [KitsuneMCP](https://github.com/elys0912/KitsuneMCP) 0.2.0 (commit b2642a9). It is the edition prepared for listing on addons.mozilla.org: it has a different add-on ID, a different native-messaging host name (`inari_mcp`) and a different state directory (`~/.inari-mcp`), so both editions can be installed side by side. For the history before the split, see the KitsuneMCP changelog.

## Unreleased (0.1.0)

### Changed

- Renamed from KitsuneMCP to Inari MCP for Firefox. Add-on ID `inari-mcp@elys0912.github.io`, host manifest `inari_mcp`, state directory `~/.inari-mcp`, npm packages `@inari-mcp/*`.
- Line endings in the repository are fixed to LF with `.gitattributes`, so the extension built on any OS is byte-identical to the one submitted for review.
- `manifest.json`: `incognito` is `not_allowed` (the extension never sees private-browsing tabs), and `data_collection_permissions` declares `websiteContent` and `browsingActivity` (page content, screenshots and URLs are sent to the local native host and from there to the MCP client).
- README: installation now starts from addons.mozilla.org (1. the extension from AMO, 2. the native host, 3. the MCP client), and the top of the README says what is sent and what is needed. The "WIP", "AMO listing not planned" and "install the unlisted .xpi from GitHub Releases" statements are gone. New sections: Permissions (what each permission is used for), Privacy and Links.
- The extension's description and the popup footer use the name "Inari MCP for Firefox" and say that page content goes only to the native host on this computer.

### Added

- Privacy policy: [docs/PRIVACY.md](./PRIVACY.md) ([日本語](./PRIVACY.ja.md)): what is read and sent, where it goes, what stays on your computer and for how long, how to delete it, consent and control, private browsing.
- Material for the addons.mozilla.org listing ([docs/amo/listing.md](./amo/listing.md)) and the Notes for Reviewers ([docs/amo/reviewer-notes.md](./amo/reviewer-notes.md)).
