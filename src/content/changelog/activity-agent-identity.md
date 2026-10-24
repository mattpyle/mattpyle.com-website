---
title: "/activity shows who an agent is"
summary: "/activity now shows how many agent hits proved who sent them, names the key directories behind signatures the site does not yet recognise, and lists the MCP clients that give a name and a protocol revision."
seoTitle: "/activity now shows who an agent is"
seoDescription: "The /activity page splits agent hits into signed, IP-verified and claimed, names unrecognised Web Bot Auth signers, and counts MCP clients and methods."
date: 2026-10-24
publishedAt: 2026-10-24T00:35:00-07:00
updated: 2026-10-24
type: feature
significance: minor
tags: ["measurement", "agents"]
draft: false
---

[/activity](/activity/) used to count fetches by user agent, and anyone can claim a user agent. It now shows three more things: how much of the traffic proved its identity, which key directories stand behind signatures this site does not yet recognise, and which MCP clients say who they are.

The figures below are production values read on 2026-10-24.

## What changed

| Where on /activity | What it shows | Since |
|---|---|---|
| By client, Verified column | Whether a hit was signed, IP-verified or only claimed | 2026-10-17 |
| Signers | The key-directory host behind a signature the site does not name | 2026-10-22 |
| MCP clients and MCP methods | Which clients call `/mcp`, and with which JSON-RPC methods | 2026-10-23 |

The same tables are in [/activity.json](/activity.json) and [/activity.md](/activity.md).

## Signed, IP-verified, claimed

Each counted request is checked two ways. A Web Bot Auth signature is verified against the signer's published key directory. A bot's address is checked against the ranges its operator publishes, and then discarded. Every hit lands in one class:

| State | What it means | Hits, last 7 days |
|---|---|---|
| signed | A Web Bot Auth signature verified | 383 |
| IP-verified | The address is in the operator's published ranges | 84 |
| claimed | The user agent says so, and nothing proves it | 1,667 |

Classification began on 2026-10-17. Older hits carry no state and show a blank in the Verified column, and the 7-day and 30-day figures are the same.

Of the 383 signed hits, 108 come from `steward-audit`, this site's own audit agent. It signs its requests, and the site verifies them as it would anyone's.

## Signers

A signature can verify under a key directory the site has no name for. Those hits used to fall into `other-bot` with the one useful fact thrown away. The Signers table keeps that fact: the host of the directory that verified the signature.

| Host | 7 days | 30 days |
|---|---|---|
| ahrefs.com | 39 | 39 |
| crawler.exa.ai | 18 | 18 |

These 57 hits sit inside the 273 `other-bot` hits marked signed in By client. The other 216 arrived before the Signers table shipped, so they have no host to show.

A host in this table is a directory the site recorded, not a verdict on who runs it. When a host proves to be an operator, the site names it by hand, and its hits move to By client under that name. Neither host is named yet.

## MCP clients and methods

Every POST to `/mcp` counts once under its JSON-RPC method. A request that names its client also adds the client's name and protocol revision to the Clients table.

| Method | 7 days | 30 days |
|---|---|---|
| initialize | 3 | 3 |
| tools/list | 2 | 2 |
| tools/call | 4 | 4 |
| server/discover | 1 | 1 |
| other-method | 0 | 0 |

The Clients table holds five rows today, and all five are this site's own probes:

| Client | Protocol version | 7 days |
|---|---|---|
| architect-prod-check | 2026-07-28 | 3 |
| architect-review | 2026-07-28 | 2 |
| architect-prod-check-legacy | 2025-06-18 | 1 |
| architect-review-legacy | 2025-06-18 | 1 |
| census-check | 2025-06-18 | 1 |

No outside client has named itself yet. Of the ten POSTs, two named no client. So the table shows the shape of the census.

Since 2026-10-24, `/mcp` also speaks the 2026-07-28 revision of the protocol. A client on that revision gives its name and version in the `_meta` envelope of every request. It adds a Clients row on any request, with no handshake. A 2025-era client still names itself once per session, in `initialize`, so its row counts sessions and a 2026-07-28 row counts requests.

## What is stored

Both identity facts are public by design, and the page's counts note says so:

1. A key-directory host is the operator's domain, which the operator publishes for exactly this purpose. It is stored alone, never beside a path, a user agent or an address.
2. A client name is the name of a piece of software, such as an editor or an inspector tool, and not of a person. It is stored alone, lowercased and cut to 64 characters. Nothing else in the request body is read.
3. Each day keeps at most 16 hosts, 16 client names and 16 protocol revisions. Further ones count as `other-host`, `other-client` and `other-version`.

The client chooses its name and its revision. A row shows what a piece of software says it is, not who runs it.
