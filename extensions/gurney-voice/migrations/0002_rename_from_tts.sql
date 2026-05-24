-- gurney-voice 0002_rename_from_tts: copy settings rows from the prior
-- extension name (`gurney-tts`) so existing users keep their voice replies and
-- selected Piper voice without re-running setup.
--
-- The per-chat preference table (`tts_chat_prefs`) is private to this
-- extension and is intentionally left under its original name — renaming it
-- would cost reversibility for no functional gain.

INSERT OR IGNORE INTO extension_settings (extension, key, value, updated_at)
SELECT 'gurney-voice', key, value, updated_at
FROM extension_settings WHERE extension = 'gurney-tts';
