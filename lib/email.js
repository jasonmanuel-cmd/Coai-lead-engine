// lib/email.js — shared transactional mailer for COAI Lead Engine.
// Uses nodemailer (already a dependency). Defaults to Gmail SMTP; override
// with EMAIL_SERVICE / EMAIL_HOST / EMAIL_PORT for any other provider.
//
// Required Vercel env vars: EMAIL_USER, EMAIL_PASS (a Gmail App Password —
// create at https://myaccount.google.com/apppasswords with 2FA on).
// Optional: EMAIL_FROM (defaults to EMAIL_USER), EMAIL_SERVICE (default 'gmail').

const nodemailer = require('nodemailer');

let transporter = null;

function emailConfigured() {
  return Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
  }
  return transporter;
}

async function sendEmail({ to, subject, text, html }) {
  if (!emailConfigured()) {
    const e = new Error('Email is not configured on the server.');
    e.statusCode = 503;
    throw e;
  }
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;
  await getTransporter().sendMail({
    from: `COAI Lead Engine <${from}>`,
    to,
    subject,
    text,
    html: html || undefined,
  });
}

module.exports = { sendEmail, emailConfigured };
