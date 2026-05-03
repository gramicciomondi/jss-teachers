require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");

const app = express();

/* ================= MIDDLEWARE ================= */
app.use(express.json());
app.use(cors());
app.use(express.static("public"));

/* ================= DATABASE ================= */
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 10
});

// TEST CONNECTION
db.getConnection((err, connection) => {
  if (err) {
    console.log("❌ DB CONNECTION ERROR:", err);
  } else {
    console.log("✅ Database Connected");
    connection.release();

    db.query(`
      CREATE TABLE IF NOT EXISTS temp_teachers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tsc_no VARCHAR(50),
        name VARCHAR(100),
        phone VARCHAR(20),
        password VARCHAR(100),
        county VARCHAR(100),
        subcounty VARCHAR(100),
        school VARCHAR(150),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.query(`
      CREATE TABLE IF NOT EXISTS teachers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tsc_no VARCHAR(50) UNIQUE,
        name VARCHAR(100),
        phone VARCHAR(20),
        password VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tsc_no VARCHAR(50),
        phone VARCHAR(20),
        amount INT DEFAULT 0,
        mpesa_code VARCHAR(50),
        status VARCHAR(20),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("✅ Tables ready");
  }
});

/* ================= SERVER ================= */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* ================= SOCKET ================= */
let users = [];

io.on("connection", socket => {
  socket.on("join", name => {
    socket.name = name;
    users.push(name);
    io.emit("onlineUsers", users);
  });

  socket.on("chatMessage", data => {
    io.emit("message", data);
  });

  socket.on("disconnect", () => {
    users = users.filter(u => u !== socket.name);
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
    console.log("❌ TOKEN ERROR:", err.response?.data || err.message);
    return null;
  }
}

/* ================= ROUTES ================= */

// SAVE TEMP
app.post("/save-teacher-temp", (req, res) => {
  const { tsc_no, name, phone, password, county, subcounty, school } = req.body;

  db.query(
    `INSERT INTO temp_teachers 
    (tsc_no, name, phone, password, county, subcounty, school)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [tsc_no, name, phone, password, county, subcounty, school],
    err => {
      if (err) {
        console.log("❌ TEMP ERROR:", err);
        return res.json({ success: false });
      }
      res.json({ success: true });
    }
  );
});

// PAY
app.post("/pay", async (req, res) => {
  try {
    const { tsc_no, phone } = req.body;

    const phoneFormatted = phone
      .replace(/\s+/g, "")
      .replace(/^\+/, "")
      .replace(/^0/, "254");

    const token = await getAccessToken();
    if (!token) return res.json({ msg: "Token failed" });

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
      [tsc_no, phoneFormatted]
    );

    await axios.post(
      `${baseURL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerBuyGoodsOnline",
        Amount: 50,
        PartyA: phoneFormatted,
        PartyB: process.env.MPESA_TILL_NUMBER,
        PhoneNumber: phoneFormatted,
        CallBackURL: process.env.CALLBACK_URL,
        AccountReference: tsc_no,
        TransactionDesc: "JSS Registration"
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log("📡 STK SENT:", phoneFormatted);
    res.json({ msg: "STK sent" });

  } catch (err) {
    console.log("❌ MPESA ERROR:", err.response?.data || err.message);
    res.json({ msg: "Payment failed" });
  }
});

// CALLBACK (FIXED CLEAN)
app.post("/callback", (req, res) => {
  console.log("📥 CALLBACK RECEIVED");
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const stk = req.body?.Body?.stkCallback;

    if (!stk || stk.ResultCode !== 0 || !stk.CallbackMetadata) {
      return res.json({ message: "ignored" });
    }

    const items = stk.CallbackMetadata.Item || [];

    const code = items.find(i => i.Name === "MpesaReceiptNumber")?.Value;
    const amount = items.find(i => i.Name === "Amount")?.Value;
    const phoneRaw = items.find(i => i.Name === "PhoneNumber")?.Value;
    const tsc_no = items.find(i => i.Name === "AccountReference")?.Value;

    if (!code || !phoneRaw || !tsc_no) {
      console.log("⚠️ Missing important fields");
      return res.json({ message: "missing data" });
    }

    let phone = phoneRaw.toString();
    if (phone.startsWith("254")) {
      phone = "0" + phone.slice(3);
    }

    db.query(
      "UPDATE payments SET status='PAID', mpesa_code=?, amount=? WHERE tsc_no=? ORDER BY id DESC LIMIT 1",
      [code, amount, tsc_no]
    );

    db.query(
      "SELECT * FROM temp_teachers WHERE phone=? ORDER BY id DESC LIMIT 1",
      [phone],
      (err, result) => {
        if (!result || result.length === 0) return;

        const t = result[0];

        db.query(
          "SELECT * FROM teachers WHERE tsc_no=?",
          [t.tsc_no],
          (err, exists) => {
            if (exists.length > 0) return;

            db.query(
              "INSERT INTO teachers (tsc_no, name, phone, password) VALUES (?, ?, ?, ?)",
              [t.tsc_no, t.name, t.phone, t.password]
            );

            console.log("🎉 TEACHER ACTIVATED:", t.tsc_no);
          }
        );
      }
    );

    console.log("✅ PAYMENT SUCCESS:", code);
    res.json({ message: "ok" });

  } catch (err) {
    console.log("❌ CALLBACK ERROR:", err);
    res.json({ message: "error" });
  }
});

// DEBUG PAYMENTS
app.get("/debug-payments", (req, res) => {
  db.query("SELECT * FROM payments ORDER BY id DESC LIMIT 10", (err, result) => {
    if (err) return res.json([]);
    res.json(result);
  });
});

// CHECK PAYMENT
app.get("/check-payment/:tsc_no", (req, res) => {
  const { tsc_no } = req.params;

  db.query(
    "SELECT * FROM payments WHERE tsc_no=? AND status='PAID' ORDER BY id DESC LIMIT 1",
    [tsc_no],
    (err, result) => {
      if (err) return res.json({ paid: false });
      res.json({ paid: result.length > 0 });
    }
  );
});

// COUNT
app.get("/count-teachers", (req, res) => {
  db.query("SELECT COUNT(*) AS total FROM teachers", (err, result) => {
    if (err) return res.json({ total: 23058 });

    const base = 23058;
    const dbCount = result[0].total || 0;

    res.json({ total: base + dbCount });
  });
});

/* ================= START ================= */
const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});