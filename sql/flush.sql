-- Wipe all scraped history (keeps schema). Used by: nix run .#flush-db
TRUNCATE messages, chats RESTART IDENTITY CASCADE;
