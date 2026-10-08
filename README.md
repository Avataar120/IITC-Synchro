# Simple Cloud Sync

One agent, many devices. **Simple Cloud Sync** keeps your IITC plugins' data — bookmarks, drawn items, keys, settings — perfectly in sync across your PC, phones and tablets, without ever giving the server (or its administrator) anything it can actually read.

## 🔒 Data protection

Protecting your data is the whole point of this project, not an afterthought.

- **End-to-end encryption, done on your device.** Every value is encrypted in your browser with AES-256-GCM *before* it is sent. The server only ever stores and relays ciphertext — it has no way to read your bookmarks, drawings or keys.
- **Your password never leaves your device.** The plugin derives your encryption key and a separate login token from your password locally (PBKDF2, 600,000 iterations, then HKDF). The raw password itself is never transmitted or stored anywhere.
- **The login token is hashed again on the server**, with scrypt, before it touches disk. Even a full copy of the server's data directory doesn't hand over usable credentials.
- **One private, isolated space per agent.** Data is partitioned by agent name; nothing is shared or readable across accounts.
- **Hardened against abuse**, not just against a curious admin: rate-limited logins and agent creation, per-agent size and entry quotas, and data files locked down to the server process only (`umask 0077`).
- **You can run the server yourself.** It's a small, dependency-free Node.js service (see [`server/`](server/)) — nothing to trust but your own infrastructure.

In short: lose the server, leak the database, or have a nosy admin — none of it exposes your synced data without your password, which only ever exists on your own devices.

## What it syncs

Simple Cloud Sync stores the `localStorage` data of your IITC plugins (bookmarks, Draw Tools, Keys, settings, …) and merges it across devices: per-key merge, most recent change wins. The server is only contacted when something actually changed.

## Installation

1. Install [IITC](https://iitc.app/) on your browser or mobile client.
2. Install the plugin: [iitc-simple-cloud-sync.user.js](https://github.com/Avataar120/IITC-Synchro/raw/main/iitc-simple-cloud-sync.user.js).
3. Open the plugin's settings, pick an agent name and a password (at least 8 characters) — this creates your private, encrypted space on the sync server.
4. Repeat steps 2–3 on your other devices with the **same** agent name and password to start syncing between them.

See the in-plugin changelog for the full version history.

## Self-hosting the sync server

The server lives in [`server/`](server/): a single-file, dependency-free Node.js (>= 18) service with its own [changelog](server/CHANGELOG.md). Copy `server/.env.example` to `.env` to configure the initial admin account and, optionally, email notifications when a new agent signs up.

## Issues

Found a bug or have a suggestion? [Open an issue](https://github.com/Avataar120/IITC-Synchro/issues).
