-- Clear conversation history and dependent per-chat settings/mappings.
TRUNCATE TABLE messages, chats RESTART IDENTITY CASCADE;
