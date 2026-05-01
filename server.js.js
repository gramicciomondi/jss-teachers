require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const axios = require("axios");

const app = express();


// ================= MIDDLEWARE =================
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

// ================= DATABASE =================
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
});

db.connect(err => {
  if (err) {
    console.log("❌ DB ERROR:", err);
  } else {
    console.log("✅ MySQL Connected");

    // 🔥 AUTO CREATE TABLES
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
        tsc_no VARCHAR(50),
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

// ================= SERVER =================
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


// ================= MPESA CONFIG =================
const baseURL =
  process.env.MPESA_ENV === "live"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

console.log("🌍 MPESA MODE:", process.env.MPESA_ENV);
console.log("🌍 BASE URL:", baseURL);

// ================= TOKEN =================
async function getAccessToken() {
  try {
    const auth = Buffer.from(
      `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString("base64");

    const res = await axios.get(
      `${baseURL}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: { Authorization: `Basic ${auth}` }
      }
    );

    return res.data.access_token;
  } catch (err) {
    console.log("❌ TOKEN ERROR:", err.response?.data || err.message);
    return null;
  }
}

// ================= SAVE TEMP =================
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

// ================= PAY =================
app.post("/pay", async (req, res) => {
  try {
    const { tsc_no, name, phone } = req.body;

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

    // Save payment
    db.query(
      "INSERT INTO payments (tsc_no, phone, amount, status) VALUES (?, ?, ?, 'PENDING')",
      [tsc_no, phoneFormatted, 50],
      err => {
        if (err) console.log("❌ PAYMENT ERROR:", err);
      }
    );

    const response = await axios.post(
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
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    console.log("📡 STK RESPONSE:", response.data);
    res.json({ msg: "STK sent" });

  } catch (err) {
    console.log("❌ MPESA ERROR:", err.response?.data || err.message);
    res.json({ msg: "Payment failed" });
  }
});

// ================= CALLBACK =================
app.post("/callback", (req, res) => {
  try {
    const stk = req.body?.Body?.stkCallback;
    if (!stk) return res.json({ message: "no data" });

    if (stk.ResultCode === 0) {
      const items = stk.CallbackMetadata.Item;

      const code = items.find(i => i.Name === "MpesaReceiptNumber")?.Value;
      let phone = items.find(i => i.Name === "PhoneNumber")?.Value;
      const amount = items.find(i => i.Name === "Amount")?.Value;

      console.log("✅ PAYMENT SUCCESS:", code);
      console.log("📲 PHONE FROM MPESA:", phone);

      // 🔄 Normalize phone (254 → 07)
      phone = phone.toString();
      if (phone.startsWith("254")) {
        phone = "0" + phone.slice(3);
      }

      console.log("🔄 NORMALIZED PHONE:", phone);

      // ✅ Update payment
      db.query(
        "UPDATE payments SET status='PAID', mpesa_code=?, amount=? WHERE phone=? ORDER BY id DESC LIMIT 1",
        [code, amount, phone],
        (err) => {
          if (err) console.log("❌ PAYMENT UPDATE ERROR:", err);
        }
      );

      // ✅ Get temp teacher
      db.query(
        "SELECT * FROM temp_teachers WHERE phone=? ORDER BY id DESC LIMIT 1",
        [phone],
        (err, result) => {

          console.log("📊 TEMP RESULT:", result);

          if (err) {
            console.log("❌ TEMP FETCH ERROR:", err);
            return;
          }

          if (!result || result.length === 0) {
            console.log("❌ NO TEMP TEACHER FOUND");
            return;
          }

          const t = result[0];

          // 🔍 Check duplicate
          db.query(
            "SELECT * FROM teachers WHERE tsc_no=?",
            [t.tsc_no],
            (err, exists) => {

              if (exists && exists.length > 0) {
                console.log("⚠️ ALREADY ACTIVATED:", t.tsc_no);
                return;
              }

              // ✅ Insert into teachers
              db.query(
                "INSERT INTO teachers (tsc_no, name, phone, password) VALUES (?, ?, ?, ?)",
                [t.tsc_no, t.name, t.phone, t.password],
                (err) => {
                  if (err) {
                    console.log("❌ ACTIVATE ERROR:", err);
                  } else {
                    console.log("🎉 TEACHER ACTIVATED:", t.tsc_no);
                  }
                }
              );

            }
          );

        }
      );
    }

    res.json({ message: "ok" });

  } catch (err) {
    console.log("❌ CALLBACK ERROR:", err);
    res.json({ message: "error" });
  }
});

// ================= CHECK PAYMENT =================
app.get("/check-payment/:tsc", (req, res) => {
  db.query(
    "SELECT * FROM teachers WHERE tsc_no=?",
    [req.params.tsc],
    (err, result) => {
      if (result.length > 0) {
        res.json({ paid: true });
      } else {
        res.json({ paid: false });
      }
    }
  );
});

// ================= LOGIN =================
app.post("/login", (req, res) => {
  const { tsc_no, password } = req.body;

  if (!tsc_no || !password) {
    return res.json({ success: false, message: "Missing credentials" });
  }

  db.query(
    "SELECT id, tsc_no, name FROM teachers WHERE tsc_no=? AND password=?",
    [tsc_no, password],
    (err, result) => {

      if (err) {
        console.log("❌ LOGIN ERROR:", err);
        return res.json({ success: false });
      }

      if (result.length > 0) {
        // ✅ SEND FULL TEACHER OBJECT
        res.json({
          success: true,
          teacher: result[0]
        });
      } else {
        res.json({ success: false });
      }
    }
  );
});
// ================= CHECK TSC =================
app.post("/check-tsc", (req, res) => {
  const { tsc_no } = req.body;

  if (!tsc_no) {
    return res.json({ exists: false });
  }

  db.query(
    "SELECT * FROM teachers WHERE tsc_no=?",
    [tsc_no],
    (err, result) => {
      if (err) {
        console.log("❌ CHECK TSC ERROR:", err);
        return res.json({ exists: false });
      }

      if (result.length > 0) {
        res.json({ exists: true, teacher: result[0] });
      } else {
        res.json({ exists: false });
      }
    }
  );
});






/* ================= ANNOUNCEMENTS ================= */
app.get("/announcements", (req, res) => {
  db.query("SELECT * FROM announcements ORDER BY id DESC",
    (err, result) => {
      if (err) return res.json([]);
      res.json(result);
    }
  );
});

app.post("/announcements", (req, res) => {
  const { content } = req.body;

  if (!content) return res.json({ success: false });

  db.query(
    "INSERT INTO announcements (content) VALUES (?)",
    [content],
    () => res.json({ success: true })
  );
});

/* ================= SWAPS ================= */
app.get("/swaps", (req, res) => {
  db.query("SELECT * FROM swaps ORDER BY id DESC",
    (err, result) => {
      if (err) return res.json([]);
      res.json(result);
    }
  );
});

app.post("/swaps", (req, res) => {
  const { name, content } = req.body;

  if (!name || !content) return res.json({ success: false });

  db.query(
    "INSERT INTO swaps (name, content) VALUES (?, ?)",
    [name, content],
    () => res.json({ success: true })
  );
});

/* ================= LINKS ================= */
app.get("/links", (req, res) => {
  db.query("SELECT * FROM links ORDER BY id DESC",
    (err, result) => {
      if (err) return res.json([]);
      res.json(result);
    }
  );
});

app.post("/links", (req, res) => {
  const { title, url } = req.body;

  if (!title || !url) return res.json({ success: false });

  db.query(
    "INSERT INTO links (title, url) VALUES (?, ?)",
    [title, url],
    () => res.json({ success: true })
  );
});
const multer = require("multer");

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});

const upload = multer({ storage });

// UPLOAD PDF
app.post("/upload-pdf", upload.single("pdf"), (req, res) => {
  const { title } = req.body;
  const filePath = "/uploads/" + req.file.filename;

  db.query(
    "INSERT INTO links (title, url) VALUES (?, ?)",
    [title, filePath],
    err => {
      if(err) return res.json({ success:false });
      res.json({ success:true });
    }
  );
});
/* ================= PAYMENTS (DASHBOARD) ================= */

// GET TODAY'S PAYMENTS
app.get("/payments/today", (req, res) => {
  const sql = `
    SELECT * FROM payments
    WHERE DATE(created_at) = CURDATE()
    AND status = 'PAID'
    ORDER BY id DESC
  `;

  db.query(sql, (err, result) => {
    if (err) {
      console.log("❌ TODAY PAYMENTS ERROR:", err);
      return res.json([]);
    }
    res.json(result);
  });
});

// GET TODAY SUMMARY
app.get("/payments/summary/today", (req, res) => {
  const sql = `
    SELECT 
      COUNT(*) as total_transactions,
      SUM(amount) as total_amount
    FROM payments
    WHERE DATE(created_at) = CURDATE()
    AND status = 'PAID'
  `;

  db.query(sql, (err, result) => {
    if (err) {
      console.log("❌ SUMMARY ERROR:", err);
      return res.json({ total_transactions: 0, total_amount: 0 });
    }

    res.json(result[0]);
  });
});
/* ================= POLLS (YES/NO SYSTEM) ================= */

/* GET POLLS */
app.get("/polls", (req, res) => {
  db.query("SELECT * FROM polls ORDER BY id DESC", (err, results) => {
    if (err) {
      console.error(err);
      return res.json([]);
    }
    res.json(results);
  });
});

/* CREATE POLL */
app.post("/create-poll", (req, res) => {
  const { question } = req.body;

  if (!question) return res.json({ success: false });

  db.query(
    "INSERT INTO polls (question, yes_votes, no_votes) VALUES (?, 0, 0)",
    [question],
    () => res.json({ success: true })
  );
});

/* VOTE */
app.post("/vote", (req, res) => {
  const { poll_id, type, teacher_id } = req.body;

  if (!poll_id || !type || !teacher_id) {
    return res.json({ success: false, message: "Missing data" });
  }

  // 🔍 Check if already voted
  db.query(
    "SELECT * FROM votes WHERE poll_id=? AND teacher_id=?",
    [poll_id, teacher_id],
    (err, result) => {

      if (result.length > 0) {
        return res.json({ success: false, message: "Already voted" });
      }

      // ✅ Insert vote record
      db.query(
        "INSERT INTO votes (poll_id, teacher_id, vote_type) VALUES (?, ?, ?)",
        [poll_id, teacher_id, type],
        () => {

          let column = type === "yes" ? "yes_votes" : "no_votes";

          // ✅ Update poll count
          db.query(
            `UPDATE polls SET ${column} = ${column} + 1 WHERE id=?`,
            [poll_id],
            () => res.json({ success: true })
          );
        }
      );
    }
  );
});

/* ================= COUNT ================= */
app.get("/count-teachers", (req, res) => {
  db.query(
    "SELECT COUNT(*) AS total FROM teachers",
    (err, result) => {
      if (err) {
        console.log(err);
        return res.json({ total: 1358 });
      }

      const base = 13058; // 👈 your starting number
      const dbCount = result[0].total || 0;

      res.json({ total: base + dbCount });
    }
  );
});
/* ================= START ================= */
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});