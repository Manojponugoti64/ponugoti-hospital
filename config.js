// Ponugoti Hospital - public Supabase configuration.
// These values are designed to be public. Data is protected by Row-Level
// Security policies on the database (see schema.sql), not by hiding these.
window.PONUGOTI_CONFIG = {
  SUPABASE_URL: "https://guudjjhraialvabauixz.supabase.co",
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1dWRqamhyYWlhbHZhYmF1aXh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2ODEzMDIsImV4cCI6MjA5NDI1NzMwMn0.oZOqJb1WgSxHvkLQ-2sEb4GSBopH_tzlzV30si9oBhc",
  HOSPITAL_NAME: "Ponugoti Hospital",
  HOSPITAL_TAGLINE: "Patient Records System",

  // --- Official header details (shown on printed discharge summaries / bills) ---
  // EDIT these to your real details. Leave blank ("") to hide a line.
  HOSPITAL_ADDRESS: "",          // e.g. "Main Road, Yourtown, Andhra Pradesh - 500001"
  HOSPITAL_PHONE: "",            // e.g. "+91 98765 43210"
  HOSPITAL_EMAIL: "",            // e.g. "ponugotihospital@gmail.com"
  HOSPITAL_REGN: "",             // e.g. "Regn. No: AP/HOSP/2020/1234"
};
