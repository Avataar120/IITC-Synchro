# Sync server changelog

## 1.7.0 (2026-10-02)
- NEW: The admin page now lists agents from the most recently updated to the least recently updated.

## 1.6.0 (2026-10-02)
- NEW: Admin sessions now last 30 days and survive closing the browser, instead of expiring after 8 hours or when the browser is closed.

## 1.5.0 (2026-09-28)
- NEW: After an admin reset, the agent's next successful sync with the temporary password is followed by a mandatory permanent password change; the temporary password stops working as soon as it is set.

## 1.4.0 (2026-09-28)
- NEW: Synced data is end-to-end encrypted by the plugin before it reaches the server: the server and its administrator can no longer read agents' data, only see its size. Requires plugin version 2.0.0 or later; older versions are rejected with a clear "update required" error.

## 1.3.0 (2026-09-27)
- NEW: The admin receives an email each time a new agent syncs with the server for the first time. Mail server, sender and recipient are set in the private `.env` file (see `.env.example`).

## 1.2.0 (2026-09-27)
- NEW: Admin page at `/admin/`: lists every agent with their synced plugins and the size of each plugin's data, resets a forgotten agent password to a one-time generated password, and lets the admin change their own password.
- NEW: The initial admin credentials come from a private `.env` file kept on the server (see `.env.example`).

## 1.1.0 (2026-09-27)
- FIX: Protected against account takeover, password guessing and storage abuse.
- FIX: New agents need a password of at least 8 characters.

## 1.0.0 (2026-09-27)
- NEW: Sync server with one private, password-protected space per agent and per-key merge where the most recent change wins.
