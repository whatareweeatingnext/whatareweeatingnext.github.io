// Public Supabase settings. The anon key is designed to be public:
// row-level security in supabase/schema.sql is what keeps your data private.
// Never put the service_role key here.
export const SUPABASE_URL = "";
export const SUPABASE_ANON_KEY = "";

// Usernames are turned into this pseudo-email for Supabase Auth.
// No mail is ever sent (email confirmation is turned off).
export const USERNAME_EMAIL_DOMAIN = "users.whatareweeatingnext.app";
