import "dotenv/config";
import express from "express";
import cookieSession from "cookie-session";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_NAME = process.env.APP_NAME || "Trợ lý Gợi Ý Làm Bài";
const APP_SLUG = (process.env.APP_SLUG || "tro-ly").replace(/^\/+|\/+$/g, "");
const MODEL = process.env.MODEL || "gpt-5.6-luna";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const DATA_DIR = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");

if (!ADMIN_PASSWORD) {
  console.warn("WARNING: ADMIN_PASSWORD chưa được đặt.");
}
if (!SESSION_SECRET) {
  console.warn("WARNING: SESSION_SECRET chưa được đặt.");
}

app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  cookieSession({
    name: "troly_session",
    keys: [SESSION_SECRET || "dev-only-change-this"],
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7
  })
);

fs.mkdirSync(DATA_DIR, { recursive: true });

function defaultStore() {
  return {
    settings: {
      appName: APP_NAME,
      slug: APP_SLUG
    },
    keys: [],
    stats: {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0
    }
  };
}

function loadStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) return defaultStore();
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...defaultStore(),
      ...parsed,
      settings: { ...defaultStore().settings, ...(parsed.settings || {}) },
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      stats: { ...defaultStore().stats, ...(parsed.stats || {}) }
    };
  } catch {
    return defaultStore();
  }
}

let store = loadStore();

function saveStore() {
  const tmp = STORE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, STORE_FILE);
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function encryptionKey() {
  const source =
    process.env.MASTER_KEY ||
    SESSION_SECRET ||
    ADMIN_PASSWORD ||
    "dev-master-key-change-this";
  return crypto.createHash("sha256").update(source).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

function decrypt(payload) {
  const [ivB64, tagB64, dataB64] = String(payload).split(".");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivB64, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 10) return "••••••••";
  return key.slice(0, 6) + "••••••••" + key.slice(-4);
}

function envKeys() {
  const many = (process.env.OPENAI_API_KEYS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const one = (process.env.OPENAI_API_KEY || "").trim();
  return [...new Set([...many, ...(one ? [one] : [])])];
}

function allKeyRecords() {
  const records = store.keys
    .filter(k => k.enabled !== false)
    .map(k => {
      try {
        return { record: k, key: decrypt(k.secret) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const fromEnv = envKeys().map(key => ({
    record: {
      id: "env-" + hash(key).slice(0, 12),
      label: "Environment",
      source: "env",
      enabled: true,
      uses: 0,
      errors: 0
    },
    key
  }));

  return [...records, ...fromEnv];
}

function publicKeyInfo(k) {
  return {
    id: k.id,
    label: k.label,
    source: k.source || "admin",
    enabled: k.enabled !== false,
    uses: k.uses || 0,
    errors: k.errors || 0,
    lastError: k.lastError || "",
    lastUsedAt: k.lastUsedAt || "",
    preview: (() => {
      try {
        return maskKey(decrypt(k.secret));
      } catch {
        return "Không đọc được";
      }
    })()
  };
}

function isAdmin(req) {
  return Boolean(req.session?.admin);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: "Bạn chưa đăng nhập quản trị." });
  next();
}

// Simple in-memory rate limit for public solve/check endpoints.
const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const windowMs = 60_000;
  const max = 20;
  const old = hits.get(ip) || [];
  const fresh = old.filter(t => now - t < windowMs);
  if (fresh.length >= max) {
    return res.status(429).json({ error: "Bạn gửi quá nhiều yêu cầu. Hãy thử lại sau 1 phút." });
  }
  fresh.push(now);
  hits.set(ip, fresh);
  next();
}

async function askOpenAI(prompt) {
  const candidates = allKeyRecords();
  if (!candidates.length) {
    throw new Error("Chưa có OpenAI API key. Hãy thêm key trong /admin hoặc Environment Variables.");
  }

  let lastError = null;

  for (const item of candidates) {
    try {
      const client = new OpenAI({ apiKey: item.key });
      const response = await client.responses.create({
        model: MODEL,
        input: prompt
      });

      const text = response.output_text?.trim();
      if (!text) throw new Error("AI không trả về nội dung.");

      if (item.record.source === "admin") {
        const found = store.keys.find(k => k.id === item.record.id);
        if (found) {
          found.uses = (found.uses || 0) + 1;
          found.lastUsedAt = new Date().toISOString();
          found.lastError = "";
        }
      }

      return text;
    } catch (err) {
      lastError = err;
      if (item.record.source === "admin") {
        const found = store.keys.find(k => k.id === item.record.id);
        if (found) {
          found.errors = (found.errors || 0) + 1;
          found.lastError = String(err?.message || err).slice(0, 500);
          found.lastErrorAt = new Date().toISOString();
        }
      }
      continue;
    }
  }

  throw new Error(
    "Tất cả API key đều không dùng được. Kiểm tra key, billing/quota và MODEL. " +
    String(lastError?.message || "")
  );
}

function buildPrompt({ mode, level, subject, question, choices, studentAnswer }) {
  const choiceText = Array.isArray(choices) && choices.length
    ? choices.map((c, i) => `${String.fromCharCode(65 + i)}. ${c}`).join("\n")
    : "(Không có lựa chọn)";

  const common =
`Bạn là "Trợ lý Gợi Ý Làm Bài", một gia sư thân thiện.
Cấp học: ${level || "Chưa chọn"}
Môn: ${subject || "Chưa chọn"}
Câu hỏi:
${question}

Các lựa chọn:
${choiceText}

Hãy trả lời bằng tiếng Việt, dễ hiểu, không bịa dữ kiện.`;

  if (mode === "explain-first") {
    return `${common}

Yêu cầu:
1. Phân tích cách làm và kiến thức cần dùng.
2. Giải thích từng bước, nhưng chưa tiết lộ đáp án chữ cái cuối cùng.
3. Nếu là trắc nghiệm, nêu điểm cần đối chiếu giữa các phương án.
4. Cuối cùng ghi đúng dòng: "👉 Bây giờ bạn hãy chọn A, B, C hoặc D."`;
  }

  if (mode === "check") {
    return `${common}

Học sinh chọn: ${studentAnswer || "(chưa chọn)"}

Hãy kiểm tra lựa chọn trên.
- Nếu đúng: nói rõ vì sao đúng.
- Nếu sai: nói rõ sai ở đâu và gợi ý cách suy nghĩ lại, sau đó nêu đáp án đúng.
- Nếu câu hỏi tự luận: nhận xét bài làm, chỉ ra điểm đúng/sai và cách cải thiện.`;
  }

  return `${common}

Hãy giải bài theo kiểu gia sư:
- Nếu trắc nghiệm: nêu đáp án đúng và giải thích vì sao; chỉ ra ngắn gọn vì sao các phương án còn lại không phù hợp.
- Nếu tự luận: trình bày hướng làm, các bước và kết luận.
- Ưu tiên gợi ý dễ hiểu thay vì chỉ đưa đáp án.`;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: store.settings.appName,
    model: MODEL
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    appName: store.settings.appName,
    slug: store.settings.slug,
    model: MODEL
  });
});

app.post("/api/login", (req, res) => {
  const password = String(req.body?.password || "");
  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Sai mật khẩu quản trị." });
  }
  req.session.admin = true;
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/admin/state", requireAdmin, (req, res) => {
  res.json({
    settings: store.settings,
    stats: store.stats,
    keys: store.keys.map(publicKeyInfo)
  });
});

app.post("/api/admin/settings", requireAdmin, (req, res) => {
  const appName = String(req.body?.appName || "").trim().slice(0, 100);
  const slug = String(req.body?.slug || "").trim().toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  if (!appName || !slug) return res.status(400).json({ error: "Tên và slug không hợp lệ." });

  store.settings.appName = appName;
  store.settings.slug = slug;
  saveStore();
  res.json({ ok: true, settings: store.settings });
});

app.post("/api/admin/keys", requireAdmin, (req, res) => {
  const key = String(req.body?.key || "").trim();
  const label = String(req.body?.label || "API key").trim().slice(0, 80);

  if (!key) return res.status(400).json({ error: "Bạn chưa nhập API key." });

  const duplicate = store.keys.some(k => {
    try { return decrypt(k.secret) === key; } catch { return false; }
  });
  if (duplicate) return res.status(409).json({ error: "API key này đã có trong hệ thống." });

  store.keys.push({
    id: crypto.randomUUID(),
    label,
    source: "admin",
    secret: encrypt(key),
    enabled: true,
    uses: 0,
    errors: 0,
    createdAt: new Date().toISOString()
  });

  saveStore();
  res.json({ ok: true });
});

app.post("/api/admin/keys/:id/toggle", requireAdmin, (req, res) => {
  const item = store.keys.find(k => k.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Không tìm thấy key." });

  item.enabled = !item.enabled;
  saveStore();
  res.json({ ok: true, enabled: item.enabled });
});

app.delete("/api/admin/keys/:id", requireAdmin, (req, res) => {
  const before = store.keys.length;
  store.keys = store.keys.filter(k => k.id !== req.params.id);
  if (store.keys.length === before) return res.status(404).json({ error: "Không tìm thấy key." });
  saveStore();
  res.json({ ok: true });
});

app.post("/api/admin/keys/:id/test", requireAdmin, async (req, res) => {
  const item = store.keys.find(k => k.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Không tìm thấy key." });

  try {
    const key = decrypt(item.secret);
    const client = new OpenAI({ apiKey: key });
    const response = await client.responses.create({
      model: MODEL,
      input: "Trả lời đúng một từ: OK"
    });
    const text = response.output_text?.trim() || "";
    item.lastError = "";
    item.lastUsedAt = new Date().toISOString();
    saveStore();
    res.json({ ok: true, result: text.slice(0, 100) });
  } catch (err) {
    item.errors = (item.errors || 0) + 1;
    item.lastError = String(err?.message || err).slice(0, 500);
    saveStore();
    res.status(400).json({ error: item.lastError });
  }
});

app.post("/api/solve", rateLimit, async (req, res) => {
  try {
    const { mode = "answer", level, subject, question, choices, studentAnswer } = req.body || {};
    if (!String(question || "").trim()) {
      return res.status(400).json({ error: "Bạn chưa nhập câu hỏi." });
    }

    store.stats.totalRequests++;
    const prompt = buildPrompt({
      mode,
      level,
      subject,
      question: String(question).slice(0, 12000),
      choices,
      studentAnswer
    });

    const answer = await askOpenAI(prompt);
    store.stats.successfulRequests++;
    saveStore();

    res.json({ ok: true, answer });
  } catch (err) {
    store.stats.failedRequests++;
    saveStore();
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post("/api/check", rateLimit, async (req, res) => {
  try {
    const { level, subject, question, choices, studentAnswer } = req.body || {};
    if (!String(question || "").trim()) {
      return res.status(400).json({ error: "Bạn chưa nhập câu hỏi." });
    }

    store.stats.totalRequests++;
    const prompt = buildPrompt({
      mode: "check",
      level,
      subject,
      question: String(question).slice(0, 12000),
      choices,
      studentAnswer
    });

    const answer = await askOpenAI(prompt);
    store.stats.successfulRequests++;
    saveStore();

    res.json({ ok: true, answer });
  } catch (err) {
    store.stats.failedRequests++;
    saveStore();
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.use(express.static(__dirname));

app.get(["/admin", "/admin/"], (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get(["/s/:slug", "/s/:slug/"], (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n${store.settings.appName}`);
  console.log(`Local: http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
  console.log(`Share: http://localhost:${PORT}/s/${store.settings.slug}`);
  console.log(`Model: ${MODEL}\n`);
});
