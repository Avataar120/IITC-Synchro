# Sync server changelog

## 1.2.0 (2026-09-27)
- NEW: Admin page at `/admin/`: lists every agent with their synced plugins and the size of each plugin's data, resets a forgotten agent password to a one-time generated password, and lets the admin change their own password.
- NEW: The initial admin credentials come from a private `.env` file kept on the server (see `.env.example`).

## 1.1.0 (2026-09-27)
- FIX: Protected against account takeover, password guessing and storage abuse.
- FIX: New agents need a password of at least 8 characters.

## 1.0.0 (2026-09-27)
- NEW: Sync server with one private, password-protected space per agent and per-key merge where the most recent change wins.
