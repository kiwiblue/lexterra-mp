// Lexterra MP — Email auth (magic link)
// POST { action: "register", email, uuid } → send magic link; returns { ok, isNew }
// POST { action: "verify",   token }       → validate token;   returns { ok, uuid, email }
// POST { action: "lookup",   uuid }        → find email;       returns { ok, email }

// ── Config ────────────────────────────────────────────────────────────────
// TODO: Update SITE_URL to your production domain.
// TODO: Update FROM_EMAIL to a verified sender in your Resend account.
//       (Resend → Domains → Add domain, then verify DNS records)
const SITE_URL   = "https://lexterragame.com";
const FROM_EMAIL = "Lexterra <noreply@lexterragame.com>";

const TOKEN_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MS   =  5 * 60 * 1000; //  5 minutes between requests per email

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function sendMagicLink(email, token, apiKey) {
  const link = `${SITE_URL}/?auth=${token}`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: email,
      subject: "Your Lexterra login link",
      html: `
        <div style="font-family:sans-serif;max-width:440px;margin:0 auto;color:#1e293b;padding:24px">
          <h2 style="color:#1e293b;margin:0 0 12px">Log in to Lexterra</h2>
          <p style="margin:0 0 8px">Click below to restore your coins, stats, and game history.</p>
          <p style="color:#64748b;font-size:0.875em;margin:0 0 20px">This link expires in 15 minutes and can only be used once.</p>
          <a href="${link}" style="display:inline-block;background:#4a90d9;color:white;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:bold;font-size:1em">Log in to Lexterra</a>
          <p style="color:#94a3b8;font-size:0.8em;margin:20px 0 0">If you didn't request this, you can safely ignore it.</p>
        </div>
      `,
    }),
  });
  return res.ok;
}

export default {
  async onRequest(req, room) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    let body;
    try { body = await req.json(); }
    catch { return json({ error: "Invalid JSON" }, 400); }

    const { action } = body;

    // ── Register ──────────────────────────────────────────────────────────
    if (action === "register") {
      const { email, uuid } = body;
      if (!email || !uuid) return json({ error: "Missing email or uuid" }, 400);

      const emailNorm = email.toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm))
        return json({ error: "Invalid email address" }, 400);

      const rateLimits = (await room.storage.get("rate_limits")) ?? {};
      const lastReq = rateLimits[emailNorm];
      if (lastReq && Date.now() - lastReq < RATE_LIMIT_MS) {
        const wait = Math.ceil((RATE_LIMIT_MS - (Date.now() - lastReq)) / 1000);
        return json({ error: `Please wait ${wait}s before requesting another link` }, 429);
      }

      // Existing registration wins → returning user gets their canonical UUID
      const emailMap = (await room.storage.get("email_map")) ?? {};
      const existing  = emailMap[emailNorm];
      const canonical = existing ?? uuid;

      if (!existing) {
        emailMap[emailNorm] = canonical;
        await room.storage.put("email_map", emailMap);
      }

      const uuidMap = (await room.storage.get("uuid_map")) ?? {};
      uuidMap[canonical] = emailNorm;
      await room.storage.put("uuid_map", uuidMap);

      // Prune expired tokens, then add new one
      const tokens = (await room.storage.get("tokens")) ?? {};
      const now = Date.now();
      for (const [k, v] of Object.entries(tokens)) {
        if (v.expiry < now) delete tokens[k];
      }
      const token = generateToken();
      tokens[token] = { email: emailNorm, uuid: canonical, expiry: now + TOKEN_EXPIRY_MS };
      await room.storage.put("tokens", tokens);

      rateLimits[emailNorm] = now;
      await room.storage.put("rate_limits", rateLimits);

      const sent = await sendMagicLink(emailNorm, token, room.env.RESEND_API_KEY);
      if (!sent) return json({ error: "Failed to send email — check Resend configuration" }, 500);

      return json({ ok: true, isNew: !existing });
    }

    // ── Verify ────────────────────────────────────────────────────────────
    if (action === "verify") {
      const { token } = body;
      if (!token) return json({ error: "Missing token" }, 400);

      const tokens = (await room.storage.get("tokens")) ?? {};
      const entry   = tokens[token];

      if (!entry) return json({ error: "Invalid or expired link" }, 400);

      if (Date.now() > entry.expiry) {
        delete tokens[token];
        await room.storage.put("tokens", tokens);
        return json({ error: "This link has expired. Please request a new one." }, 400);
      }

      delete tokens[token]; // single-use
      await room.storage.put("tokens", tokens);

      return json({ ok: true, uuid: entry.uuid, email: entry.email });
    }

    // ── Lookup ────────────────────────────────────────────────────────────
    if (action === "lookup") {
      const { uuid } = body;
      if (!uuid) return json({ error: "Missing uuid" }, 400);
      const uuidMap = (await room.storage.get("uuid_map")) ?? {};
      return json({ ok: true, email: uuidMap[uuid] ?? null });
    }

    return json({ error: "Unknown action" }, 400);
  },
};
