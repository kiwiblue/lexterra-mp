// Lexterra MP — Email auth (magic link)
// POST { action: "register", email, uuid } → send magic link; returns { ok }
// POST { action: "verify",   token }       → validate token;   returns { ok, uuid, email }
// POST { action: "lookup",   uuid }        → find email;       returns { ok, email }

import { Server } from "partyserver";
import { makeRoom, isUuid } from "./compat.js";

// ── Config ────────────────────────────────────────────────────────────────
const SITE_URL   = "https://lexterragame.com";
const FROM_EMAIL = { email: "noreply@lexterragame.com", name: "Lexterra" };

const TOKEN_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MS   =  5 * 60 * 1000; //  5 minutes between requests per email
const SEND_WINDOW_MS  = 60 * 60 * 1000; // global cap: at most SEND_MAX_PER_WINDOW emails per hour
const SEND_MAX_PER_WINDOW = 60;

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

// Sent via Cloudflare Email Service (the EMAIL binding in wrangler.jsonc)
async function sendMagicLink(email, token, mailer) {
  const link = `${SITE_URL}/?auth=${token}`;
  try {
    await mailer.send({
      to: email,
      from: FROM_EMAIL,
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
      text: `Log in to Lexterra\n\nOpen this link to restore your coins, stats, and game history:\n${link}\n\nThis link expires in 15 minutes and can only be used once. If you didn't request this, you can safely ignore it.`,
    });
    return true;
  } catch (err) {
    console.error(`Magic link send failed: ${err.code ?? ""} ${err.message}`);
    return false;
  }
}

const handlers = {
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
      if (typeof email !== "string" || !isUuid(uuid)) return json({ error: "Missing email or uuid" }, 400);

      const emailNorm = email.toLowerCase().trim();
      if (emailNorm.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm))
        return json({ error: "Invalid email address" }, 400);

      const now = Date.now();
      const rateLimits = (await room.storage.get("rate_limits")) ?? {};
      for (const [k, t] of Object.entries(rateLimits)) if (now - t >= RATE_LIMIT_MS) delete rateLimits[k];
      const lastReq = rateLimits[emailNorm];
      if (lastReq && now - lastReq < RATE_LIMIT_MS) {
        const wait = Math.ceil((RATE_LIMIT_MS - (now - lastReq)) / 1000);
        return json({ error: `Please wait ${wait}s before requesting another link` }, 429);
      }
      // Global cap so the service can't be used to spam arbitrary addresses
      const sendLog = ((await room.storage.get("send_log")) ?? []).filter(t => now - t < SEND_WINDOW_MS);
      if (sendLog.length >= SEND_MAX_PER_WINDOW) return json({ error: "Too many login requests right now — please try again later" }, 429);

      // An email only becomes linked to an account when its owner clicks the link, so
      // nobody can claim someone else's address ahead of them.
      const emailMap = (await room.storage.get("email_map")) ?? {};
      const existing = emailMap[emailNorm];

      const tokens = (await room.storage.get("tokens")) ?? {};
      for (const [k, v] of Object.entries(tokens)) if (v.expiry < now) delete tokens[k];
      const token = generateToken();
      tokens[token] = existing
        ? { email: emailNorm, uuid: existing, mergeFrom: uuid !== existing ? uuid : null, expiry: now + TOKEN_EXPIRY_MS }
        : { email: emailNorm, uuid, mergeFrom: null, claimNew: true, expiry: now + TOKEN_EXPIRY_MS };
      await room.storage.put("tokens", tokens);

      rateLimits[emailNorm] = now;
      await room.storage.put("rate_limits", rateLimits);
      sendLog.push(now);
      await room.storage.put("send_log", sendLog);

      const sent = await sendMagicLink(emailNorm, token, room.env.EMAIL);
      if (!sent) return json({ error: "Failed to send email — please try again shortly" }, 500);

      return json({ ok: true });
    }

    // ── Verify ────────────────────────────────────────────────────────────
    if (action === "verify") {
      const { token } = body;
      if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return json({ error: "Missing token" }, 400);

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

      // First verified click links the email to this account. If someone else verified the
      // same email meanwhile, their account is canonical and this one merges into it.
      if (entry.claimNew) {
        const emailMap = (await room.storage.get("email_map")) ?? {};
        const uuidMap  = (await room.storage.get("uuid_map")) ?? {};
        const owner = emailMap[entry.email];
        if (owner && owner !== entry.uuid) {
          entry.mergeFrom = entry.uuid;
          entry.uuid = owner;
        } else if (!owner) {
          emailMap[entry.email] = entry.uuid;
          uuidMap[entry.uuid] = entry.email;
          await room.storage.put("email_map", emailMap);
          await room.storage.put("uuid_map", uuidMap);
        }
      }

      // Merge the old UUID's stats/coins/XP into the canonical UUID (best-effort)
      if (entry.mergeFrom && entry.mergeFrom !== entry.uuid) {
        try {
          await room.context.parties.stats.get("main").fetch("/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "merge_uuid", fromUuid: entry.mergeFrom, toUuid: entry.uuid }),
          });
        } catch {}
      }

      return json({ ok: true, uuid: entry.uuid, email: entry.email });
    }

    // ── Lookup ────────────────────────────────────────────────────────────
    if (action === "lookup") {
      const { uuid } = body;
      if (!isUuid(uuid)) return json({ error: "Missing uuid" }, 400);
      const uuidMap = (await room.storage.get("uuid_map")) ?? {};
      return json({ ok: true, email: uuidMap[uuid] ?? null });
    }

    return json({ error: "Unknown action" }, 400);
  },
};

export class Auth extends Server {
  room = makeRoom(this);
  onRequest(req) { return handlers.onRequest(req, this.room); }
}
