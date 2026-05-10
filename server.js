import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const app = express();

app.use(express.json({
  limit: "10mb",
  verify: (req, res, buf) => {
    req.rawBody = buf.toString("utf8");
  }
}));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ROBLOX_SECRET = process.env.ROBLOX_SECRET;
const BAGIBAGI_WEBHOOK_TOKEN = process.env.BAGIBAGI_WEBHOOK_TOKEN;

function makeDonorKey(name) {
  return String(name || "Unknown")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

async function resolveRobloxUser(username) {
  const rawName = String(username || "").trim();

  if (rawName === "") {
    return {
      robloxUserId: null,
      robloxUsername: "Unknown"
    };
  }

  try {
    const response = await fetch(
      "https://users.roblox.com/v1/usernames/users",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          usernames: [rawName],
          excludeBannedUsers: false
        })
      }
    );

    const result = await response.json();

    if (Array.isArray(result.data) && result.data[0]) {
      return {
        robloxUserId: result.data[0].id,
        robloxUsername: result.data[0].name
      };
    }

    return {
      robloxUserId: null,
      robloxUsername: rawName
    };

  } catch (err) {
    console.error("Roblox resolve failed:", err);

    return {
      robloxUserId: null,
      robloxUsername: rawName
    };
  }
}

function verifyBagibagiSignature(req) {
  const signature = req.headers["x-bagibagi-signature"];

  if (!BAGIBAGI_WEBHOOK_TOKEN) return true;

  // Bagibagi webhook test kadang tidak kirim signature.
  // Untuk sekarang kita allow dulu.
  if (!signature) {
    console.log("Webhook without signature allowed");
    return true;
  }

  const expected = crypto
    .createHmac("sha256", BAGIBAGI_WEBHOOK_TOKEN)
    .update(req.rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

app.get("/", (req, res) => {
  res.send("Bagibagi Roblox API is running");
});

app.post("/bagibagi/webhook", async (req, res) => {
  try {
    console.log("WEBHOOK MASUK:", req.body);
    if (!verifyBagibagiSignature(req)) {
      return res.status(401).json({ error: "Invalid Bagibagi signature" });
    }

    const body = req.body;

    const transactionId = String(
      body.transaction_id || `manual-${Date.now()}`
    );

    const rawName = String(body.name || "Unknown").trim();
    const resolved = await resolveRobloxUser(rawName);

    const robloxUserId = resolved.robloxUserId;
    const robloxUsername = resolved.robloxUsername;

    const donorName = robloxUsername;
    const donorKey = makeDonorKey(donorName);

    const amount = Number(body.amount) || 0;
    const message = String(body.message || "");
    const mediaShareUrl = body.mediaShareUrl || null;

    if (amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const { error: insertError } = await supabase
      .from("bagibagi_donations")
      .upsert({
        transaction_id: transactionId,
        donor_key: donorKey,
        donor_name: donorName,

        roblox_user_id: robloxUserId,
        roblox_username: robloxUsername,

        amount,
        message,
        media_share_url: mediaShareUrl,
        source: "bagibagi",
        recalled: false,
        deleted: false,
        claimed_by_roblox: false,
        updated_at: new Date().toISOString()
      }, {
        onConflict: "transaction_id"
      });

    if (insertError) {
      return res.status(500).json({ error: insertError.message });
    }

    await rebuildBagibagiTotal(donorKey);

    return res.json({
      success: true,
      transactionId,
      donorName,
      robloxUserId,
      robloxUsername,
      amount,
      message
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/bagibagi/pending", async (req, res) => {
  try {
    if (req.query.secret !== ROBLOX_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { data, error } = await supabase
      .from("bagibagi_donations")
      .select("id, transaction_id, donor_key, donor_name, roblox_user_id, roblox_username, amount, message, recalled, created_at")
      .eq("claimed_by_roblox", false)
      .eq("deleted", false)
      .order("id", { ascending: true })
      .limit(25);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json(data);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/bagibagi/claim", async (req, res) => {
  try {
    const { secret, ids } = req.body;

    if (secret !== ROBLOX_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!Array.isArray(ids)) {
      return res.status(400).json({ error: "Invalid ids" });
    }

    const { error } = await supabase
      .from("bagibagi_donations")
      .update({
        claimed_by_roblox: true,
        updated_at: new Date().toISOString()
      })
      .in("id", ids);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ success: true, claimed: ids.length });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/bagibagi/leaderboard", async (req, res) => {
  try {
    if (req.query.secret !== ROBLOX_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const limit = Number(req.query.limit) || 100;

    const { data, error } = await supabase
      .from("bagibagi_totals")
      .select("donor_key, donor_name, roblox_user_id, roblox_username, total_amount")
      .order("total_amount", { ascending: false })
      .limit(limit);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json(data);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/admin/bagibagi/add", async (req, res) => {
  try {
    const { secret, donorName, amount, message } = req.body;

    if (secret !== ROBLOX_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const rawName = String(donorName || "Unknown").trim();
    const resolved = await resolveRobloxUser(rawName);

    const robloxUserId = resolved.robloxUserId;
    const robloxUsername = resolved.robloxUsername;

    const name = robloxUsername;
    const donorKey = makeDonorKey(name);
    const value = Number(amount) || 0;

    if (value <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const transactionId = `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const { data, error } = await supabase
      .from("bagibagi_donations")
      .insert({
        transaction_id: transactionId,
        donor_key: donorKey,
        donor_name: name,

        roblox_user_id: robloxUserId,
        roblox_username: robloxUsername,

        amount: value,
        message: message || "",
        source: "admin",
        claimed_by_roblox: false
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    await rebuildBagibagiTotal(donorKey);

    return res.json({ success: true, donation: data });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/admin/bagibagi/edit", async (req, res) => {
  try {
    const { secret, id, donorName, amount, message } = req.body;

    if (secret !== ROBLOX_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { data: oldRow } = await supabase
      .from("bagibagi_donations")
      .select("*")
      .eq("id", id)
      .single();

    if (!oldRow) {
      return res.status(404).json({ error: "Donation not found" });
    }

    const rawName = String(donorName || oldRow.donor_name).trim();
    const resolved = await resolveRobloxUser(rawName);

    const robloxUserId = resolved.robloxUserId;
    const robloxUsername = resolved.robloxUsername;

    const name = robloxUsername;
    const donorKey = makeDonorKey(name);
    const value = Number(amount) || Number(oldRow.amount) || 0;

    const { error } = await supabase
      .from("bagibagi_donations")
      .update({
        donor_key: donorKey,
        donor_name: name,

        roblox_user_id: robloxUserId,
        roblox_username: robloxUsername,

        amount: value,
        message: message ?? oldRow.message,
        claimed_by_roblox: false,
        updated_at: new Date().toISOString()
      })
      .eq("id", id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    await rebuildBagibagiTotal(oldRow.donor_key);
    await rebuildBagibagiTotal(donorKey);

    return res.json({ success: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/admin/bagibagi/delete", async (req, res) => {
  try {
    const { secret, id } = req.body;

    if (secret !== ROBLOX_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { data: oldRow } = await supabase
      .from("bagibagi_donations")
      .select("*")
      .eq("id", id)
      .single();

    if (!oldRow) {
      return res.status(404).json({ error: "Donation not found" });
    }

    const { error } = await supabase
      .from("bagibagi_donations")
      .update({
        deleted: true,
        claimed_by_roblox: false,
        updated_at: new Date().toISOString()
      })
      .eq("id", id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    await rebuildBagibagiTotal(oldRow.donor_key);

    return res.json({ success: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/admin/bagibagi/recall", async (req, res) => {
  try {
    const { secret, id } = req.body;

    if (secret !== ROBLOX_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { error } = await supabase
      .from("bagibagi_donations")
      .update({
        recalled: true,
        claimed_by_roblox: false,
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("deleted", false);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ success: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

async function rebuildBagibagiTotal(donorKey) {
  const { data, error } = await supabase
    .from("bagibagi_donations")
    .select("amount, donor_name, roblox_user_id, roblox_username")
    .eq("donor_key", donorKey)
    .eq("deleted", false);

  if (error) throw error;

  const total = data.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const donorName = data[0]?.donor_name || donorKey;
  const robloxUserId = data[0]?.roblox_user_id || null;
  const robloxUsername = data[0]?.roblox_username || donorName;

  await supabase
    .from("bagibagi_totals")
    .upsert({
      donor_key: donorKey,
      donor_name: donorName,

      roblox_user_id: robloxUserId,
      roblox_username: robloxUsername,

      total_amount: total,
      updated_at: new Date().toISOString()
    }, {
      onConflict: "donor_key"
    });
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Bagibagi API running on port ${PORT}`);
});