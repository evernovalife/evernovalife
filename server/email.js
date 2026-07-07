/* ============================================================
   EVER NOVA LIFE — outbound email (Gmail SMTP via nodemailer)
   Used for password-reset links. Configure with SMTP_USER +
   SMTP_PASS (a Gmail "app password", not your normal password).
   If it's not configured, sending throws — callers handle that.
   ============================================================ */

const nodemailer = require('nodemailer');

const HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const PORT = Number(process.env.SMTP_PORT || 587);
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const FROM = process.env.SMTP_FROM || (USER ? `Ever Nova Life <${USER}>` : '');

const CONFIGURED = !!(USER && PASS);

let transporter = null;
function getTransporter() {
  if (!CONFIGURED) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: HOST,
      port: PORT,
      secure: PORT === 465,          // 465 = implicit TLS; 587 = STARTTLS
      auth: { user: USER, pass: PASS }
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t) throw new Error('Email is not configured (set SMTP_USER / SMTP_PASS).');
  return t.sendMail({ from: FROM, to, subject, text, html });
}

module.exports = { CONFIGURED, sendMail, FROM };
