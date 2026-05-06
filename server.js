require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const multer = require("multer");

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
  waitForConnections: true,
  connectionLimit: 10
});

console.log("✅ Database pool ready");

/* ================= SERVER + SOCKET ================= */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

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

/* ================= MPESA CONFIG ================= */
const baseURL =
  process.env.MPESA_ENV === "live"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

/* ================= GET TOKEN ================= */
async function getAccessToken() {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString("base64");

  const res = await axios.get(
    `${baseURL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  return res.data.access_token;
}

/* ================= SAVE TEMP TEACHER ================= */
app.post("/save-teacher-temp", (req, res) => {
  const { tsc_no, name, phone, password, county, subcounty, school } = req.body;

  db.query(
    `INSERT INTO temp_teachers 
    (tsc_no, name, phone, password, county, subcounty, school)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
    name=VALUES(name),
    phone=VALUES(phone),
    password=VALUES(password),
    county=VALUES(county),
    subcounty=VALUES(subcounty),
    school=VALUES(school)`,
    [tsc_no, name, phone, password, county, subcounty, school],
    () => res.json({ success: true })
  );
});

/* ================= PAY (STK PUSH) ================= */
app.post("/pay", async (req, res) => {
  try {
    let { phone, tsc_no } = req.body;

    phone = phone.replace(/^0/, "254");

    const token = await getAccessToken();

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
      [tsc_no, phone]
    );

    await axios.post(
      `${baseURL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: 50,
        PartyA: phone,
        PartyB: process.env.MPESA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: process.env.CALLBACK_URL,
        AccountReference: tsc_no,
        TransactionDesc: "JSS Registration"
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json({ success: true });

  } catch (err) {
    console.log("❌ MPESA ERROR:", err.message);
    res.json({ success: false });
  }
});

/* ================= CALLBACK ================= */
app.post("/callback", (req, res) => {
  try {
    const stk = req.body?.Body?.stkCallback;

    if (!stk) return res.json({ ResultCode: 0 });

    const tsc_no = stk.AccountReference;

    if (stk.ResultCode === 0 && stk.CallbackMetadata) {
      const items = stk.CallbackMetadata?.Item || [];

      const code = items.find(i => i.Name === "MpesaReceiptNumber")?.Value;
      const amount = items.find(i => i.Name === "Amount")?.Value;

      // update payment
      db.query(
        "UPDATE payments SET status='PAID', mpesa_code=? WHERE tsc_no=? ORDER BY id DESC LIMIT 1",
        [code, tsc_no]
      );

      // move teacher from temp → final
      db.query(
        "SELECT * FROM temp_teachers WHERE tsc_no=?",
        [tsc_no],
        (err, result) => {
          if (result.length > 0) {
            const t = result[0];

            db.query(
              `INSERT INTO teachers 
              (tsc_no, name, phone, password, county, subcounty, school)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                t.tsc_no,
                t.name,
                t.phone,
                t.password,
                t.county,
                t.subcounty,
                t.school
              ]
            );

            db.query("DELETE FROM temp_teachers WHERE tsc_no=?", [tsc_no]);
          }
        }
      );
    }

    res.json({ ResultCode: 0 });

  } catch (err) {
    console.log("❌ CALLBACK ERROR:", err.message);
    res.json({ ResultCode: 0 });
  }
});

/* ================= CHECK PAYMENT ================= */
app.get("/check-payment/:tsc", (req, res) => {
  db.query(
    "SELECT * FROM teachers WHERE tsc_no=?",
    [req.params.tsc],
    (err, result) => {
      res.json({ paid: result.length > 0 });
    }
  );
});

/* ================= LOGIN ================= */
app.post("/login", (req, res) => {
  const { tsc_no, password } = req.body;

  db.query(
    "SELECT id, tsc_no, name FROM teachers WHERE tsc_no=? AND password=?",
    [tsc_no, password],
    (err, result) => {
      if (result.length > 0) {
        res.json({ success: true, teacher: result[0] });
      } else {
        res.json({ success: false });
      }
    }
  );
});

/* ================= CHECK TSC ================= */
app.post("/check-tsc", (req, res) => {
  db.query(
    "SELECT * FROM teachers WHERE tsc_no=?",
    [req.body.tsc_no],
    (err, result) => {
      res.json({ exists: result.length > 0 });
    }
  );
});

/* ================= COUNT ================= */
app.get("/count-teachers", (req, res) => {
  db.query("SELECT COUNT(*) AS total FROM teachers", (err, result) => {
    res.json({ total: result[0]?.total || 0 });
  });
});

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});