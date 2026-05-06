require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const path = require("path");

const app = express();

/* ================= MIDDLEWARE ================= */
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

/* ================= HEALTH CHECK (IMPORTANT FOR RENDER) ================= */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* ================= ROOT ================= */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ================= DATABASE ================= */
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

db.getConnection((err) => {
  if (err) console.log("❌ DB ERROR:", err.message);
  else console.log("✅ Database Connected");
});

/* ================= SERVER ================= */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* ================= SOCKET ================= */
let users = [];

io.on("connection", (socket) => {
  socket.on("join", (name) => {
    socket.name = name;

    if (!users.includes(name)) {
      users.push(name);
    }

    io.emit("onlineUsers", users);
  });

  socket.on("chatMessage", (data) => {
    io.emit("message", data);
  });

  socket.on("disconnect", () => {
    users = users.filter((u) => u !== socket.name);
    io.emit("onlineUsers", users);
  });
});

/* ================= MPESA ================= */
const baseURL =
  process.env.MPESA_ENV === "live"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

async function getAccessToken() {
  try {
    const auth = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString("base64");

    const res = await axios.get(
      `${baseURL}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${auth}` } }
    );

    return res.data.access_token;
  } catch (err) {
    console.log("❌ TOKEN ERROR:", err.message);
    return null;
  }
}

/* ================= SAVE TEMP ================= */
app.post("/save-teacher-temp", (req, res) => {
  const data = req.body;

  const sql = `
    INSERT INTO temp_teachers
    (tsc_no, name, phone, password, county, subcounty, school)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE name=VALUES(name)
  `;

  db.query(
    sql,
    [
      data.tsc_no,
      data.name,
      data.phone,
      data.password,
      data.county,
      data.subcounty,
      data.school
    ],
    (err) => {
      if (err) {
        console.log("TEMP ERROR:", err.message);
        return res.json({ success: false });
      }
      res.json({ success: true });
    }
  );
});

/* ================= PAY ================= */
app.post("/pay", async (req, res) => {
  try {
    const { tsc_no, phone } = req.body;

    const cleanPhone = phone.replace(/^0/, "254");

    const token = await getAccessToken();
    if (!token) return res.json({ success: false, msg: "Token failed" });

    const timestamp = new Date()
      .toISOString()
      .replace(/[-T:\.Z]/g, "")
      .slice(0, 14);

    const password = Buffer.from(
      process.env.MPESA_SHORTCODE +
      process.env.MPESA_PASSKEY +
      timestamp
    ).toString("base64");

    db.query(
      "INSERT INTO payments (tsc_no, phone, amount, status) VALUES (?, ?, 50, 'PENDING')",
      [tsc_no, cleanPhone]
    );

    await axios.post(
      `${baseURL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: 50,
        PartyA: cleanPhone,
        PartyB: process.env.MPESA_SHORTCODE,
        PhoneNumber: cleanPhone,
        CallBackURL: process.env.CALLBACK_URL,
        AccountReference: tsc_no,
        TransactionDesc: "JSS Registration"
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json({ success: true });
  } catch (err) {
    console.log("MPESA ERROR:", err.message);
    res.json({ success: false });
  }
});

/* ================= CALLBACK ================= */
app.post("/callback", (req, res) => {
  try {
    const stk = req.body?.Body?.stkCallback;
    if (!stk) return res.json({ ok: true });

    if (stk.ResultCode === 0) {
      const items = stk.CallbackMetadata?.Item || [];

      const code = items.find(i => i.Name === "MpesaReceiptNumber")?.Value;
      const phone = items.find(i => i.Name === "PhoneNumber")?.Value;
      const amount = items.find(i => i.Name === "Amount")?.Value;

      if (phone) {
        db.query(
          "UPDATE payments SET status='PAID', mpesa_code=?, amount=? WHERE phone=? ORDER BY id DESC LIMIT 1",
          [code, amount, phone]
        );
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.log("CALLBACK ERROR:", err.message);
    res.json({ ok: true });
  }
});

/* ================= CHECK TSC ================= */
app.post("/check-tsc", (req, res) => {
  db.query(
    "SELECT id FROM teachers WHERE tsc_no=?",
    [req.body.tsc_no],
    (err, result) => {
      if (err) {
        console.log(err.message);
        return res.json({ exists: false });
      }

      res.json({ exists: result.length > 0 });
    }
  );
});

/* ================= COUNT ================= */
app.get("/count-teachers", (req, res) => {
  db.query("SELECT COUNT(*) AS total FROM teachers", (err, result) => {
    if (err) {
      return res.json({ total: 23058 });
    }

    const base = 23058;
    const count = result?.[0]?.total || 0;

    res.json({ total: base + count });
  });
});

/* ================= LOGIN ================= */
app.post("/login", (req, res) => {
  const { tsc_no, password } = req.body;

  db.query(
    "SELECT id, tsc_no, name FROM teachers WHERE tsc_no=? AND password=?",
    [tsc_no, password],
    (err, result) => {
      if (err) return res.json({ success: false });

      if (result.length > 0) {
        res.json({ success: true, teacher: result[0] });
      } else {
        res.json({ success: false });
      }
    }
  );
});

/* ================= START ================= */
const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});