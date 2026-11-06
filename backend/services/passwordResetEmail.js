const nodemailer = require('nodemailer');
const config = require('../config/env');

const isSmtpConfigured = smtp =>
  Boolean(smtp.host && smtp.port && smtp.user && smtp.pass && smtp.from);

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[character]);

const createPasswordResetEmail = ({ resetUrl, ownerName = 'there' }) => {
  const safeName = escapeHtml(ownerName);
  const safeUrl = escapeHtml(resetUrl);
  return {
    subject: 'Reset Your SS Fitness Manager Password',
    text: `Hello ${ownerName},\n\nUse this link to reset your SS Fitness Manager password within 15 minutes:\n${resetUrl}\n\nIf you did not request this reset, you can ignore this email. Your password will not change.`,
    html: `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f4f5f8;font-family:Arial,sans-serif;color:#202124">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden">
          <tr><td style="padding:28px;background:#e5242a;color:#fff;text-align:center">
            <div style="font-size:22px;font-weight:800;letter-spacing:1px">SS FITNESS</div>
            <div style="font-size:12px;letter-spacing:3px;margin-top:4px">MANAGER</div>
          </td></tr>
          <tr><td style="padding:32px">
            <h1 style="font-size:23px;margin:0 0 16px">Reset your password</h1>
            <p style="font-size:15px;line-height:1.6">Hello ${safeName}, we received a request to reset your SS Fitness Manager password.</p>
            <p style="margin:26px 0;text-align:center">
              <a href="${safeUrl}" style="display:inline-block;padding:14px 24px;border-radius:8px;background:#e5242a;color:#fff;text-decoration:none;font-weight:700">Reset Password</a>
            </p>
            <p style="font-size:13px;line-height:1.6;color:#555">This secure link expires in <strong>15 minutes</strong> and can only be used once.</p>
            <p style="font-size:13px;line-height:1.6;color:#555">If you did not request this reset, ignore this email. Your password will not change.</p>
            <p style="font-size:12px;line-height:1.5;color:#777;word-break:break-all">If the button does not work, copy this link into your browser:<br><a href="${safeUrl}" style="color:#b51f25">${safeUrl}</a></p>
          </td></tr>
          <tr><td style="padding:16px 28px;background:#f8f8fa;color:#888;font-size:11px;text-align:center">SS Fitness Manager · Account Security</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`
  };
};

const sendPasswordResetEmail = async ({
  email,
  ownerName,
  resetUrl,
  smtp = config.smtp,
  createTransport = nodemailer.createTransport
}) => {
  if (!isSmtpConfigured(smtp)) {
    const error = new Error('SMTP_NOT_CONFIGURED');
    error.code = 'SMTP_NOT_CONFIGURED';
    throw error;
  }
  const transport = createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass }
  });
  const message = createPasswordResetEmail({ resetUrl, ownerName });
  return transport.sendMail({
    from: smtp.from,
    to: email,
    subject: message.subject,
    text: message.text,
    html: message.html
  });
};

module.exports = {
  isSmtpConfigured,
  createPasswordResetEmail,
  sendPasswordResetEmail
};
