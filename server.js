require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const http = require("http");
const axios = require("axios");

const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static("public"));

/* ================= DB ================= */
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  connectionLimit: 10
});

/* ================= COUNT ================= */
app.get("/count-teachers", (req, res) => {
  db.query("SELECT COUNT(*) AS total FROM teachers", (err, result) => {
    if (err) return res.json({ total: 0 });
    res.json({ total: result[0].total || 0 });
  });
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

/* ================= TEMP SAVE ================= */
app.post("/save-teacher-temp", (req, res) => {
  const { tsc_no, name, phone, password, county, subcounty, school } = req.body;

  db.query(
    `INSERT INTO temp_teachers 
    (tsc_no,name,phone,password,county,subcounty,school)
    VALUES (?,?,?,?,?,?,?)`,
    [tsc_no,name,phone,password,county,subcounty,school],
    () => res.json({ success: true })
  );
});

/* ================= MPESA (SIMPLIFIED SAFE MODE) ================= */
app.post("/pay", async (req, res) => {
  try {
    const { phone, tsc_no } = req.body;

    db.query(
      "INSERT INTO payments (tsc_no, phone, amount, status) VALUES (?,?,50,'PENDING')",
      [tsc_no, phone]
    );

    res.json({ success: true });

  } catch (e) {
    res.json({ success: false });
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

/* ================= START ================= */
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on " + PORT);
});