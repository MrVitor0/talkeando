-- User profile fields: bio/about me, banner preset, pronouns.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_preset TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pronouns TEXT;
