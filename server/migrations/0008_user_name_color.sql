-- Per-user display-name colour. Any member may set their own or anyone
-- else's (the "qualquer membro" scoping, same as rename). NULL = the
-- default colour (owner gold / hashed hue) picked client-side.
ALTER TABLE users ADD COLUMN name_color TEXT;
